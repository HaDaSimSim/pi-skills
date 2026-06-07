// update-models manages the `relay` provider entry in pi's models.json.
//
// The Relay server exposes a JSON endpoint primarily intended for OpenCode
// (`/integration/opencode/config`). It returns a ready-to-merge OpenCode
// provider config — `provider.relay.{options.baseURL, models: {<id>: ...}}`
// shaped after `@ai-sdk/openai-compatible`.
//
// pi expects a different shape under `providers.relay.{baseUrl, api, apiKey,
// models: [...]}`. This binary fetches the OpenCode payload, translates it
// into pi's shape, and writes it back into ~/.pi/agent/models.json without
// touching any other providers the user has configured.
//
// Subcommands:
//
//	update-models refresh                Fetch latest config, merge into models.json
//	update-models setup [--api-key K]    Save API key into .env (and run refresh)
//	update-models remove                 Drop the `relay` provider from models.json
//	update-models status                 Show what's currently configured
//	update-models test                   Hit chat/completions with the first model
//
// Real output goes to stdout; progress and errors go to stderr so pi can
// distinguish "this is the result" from "this is a status line".
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultSetupURL = "https://relay-api.algorix.io/integration/opencode/config"
	providerName    = "relay"

	envPrimaryAPIKey = "RELAY_API_KEY"
	envAltAPIKey     = "PI_RELAY_API_KEY"
	envSetupURL      = "RELAY_SETUP_URL"
	envModelsPath    = "PI_MODELS_PATH"

	httpTimeout = 60 * time.Second

	// piAPIKey is the literal value written into models.json under
	// `providers.relay.apiKey`. pi resolves the leading `$` against the
	// process env at request time, so the user only needs
	// `export PI_RELAY_API_KEY=...` in their shell rc for completions to
	// work. This skill does not touch the user's shell.
	piAPIKey = "$PI_RELAY_API_KEY"
	piAPI    = "openai-completions"
)

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  update-models refresh                Fetch Relay config and update models.json
  update-models setup [--api-key K]    Save API key to .env, then refresh
  update-models remove                 Remove the relay provider from models.json
  update-models status                 Show current Relay config status
  update-models test                   Run a chat completion against the first model

Env:
  RELAY_API_KEY        API key (sk-relay-...). PI_RELAY_API_KEY also accepted.
                       Falls back to a KEY=VALUE .env next to the binary.
  RELAY_SETUP_URL      Override config endpoint
                       (default: `+defaultSetupURL+`)
  PI_MODELS_PATH       Override models.json path
                       (default: ~/.pi/agent/models.json)`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	sub, args := os.Args[1], os.Args[2:]
	var err error
	switch sub {
	case "refresh":
		err = runRefresh(args)
	case "setup":
		err = runSetup(args)
	case "remove":
		err = runRemove(args)
	case "status":
		err = runStatus(args)
	case "test":
		err = runTest(args)
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", sub)
		usage()
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// ---------- subcommands ----------

func runRefresh(args []string) error {
	if err := flag.NewFlagSet("refresh", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}

	apiKey, err := requireAPIKey()
	if err != nil {
		return err
	}
	setupURL := getSetupURL()
	modelsPath, err := getModelsPath()
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "Fetching %s\n", setupURL)
	body, err := fetchConfig(setupURL, apiKey)
	if err != nil {
		return err
	}

	relay, err := parseOpenCodeRelay(body)
	if err != nil {
		return err
	}

	if err := mergeRelay(modelsPath, relay); err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "Wrote %s\n", modelsPath)
	printRelaySummary(os.Stdout, modelsPath, relay)
	return nil
}

func runSetup(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	apiKey := fs.String("api-key", "", "Relay API key (sk-relay-...). Prompts on /dev/tty if missing.")
	skipRefresh := fs.Bool("skip-refresh", false, "Save .env only, do not call refresh.")
	if err := fs.Parse(args); err != nil {
		return err
	}

	key := strings.TrimSpace(*apiKey)
	if key == "" {
		key = strings.TrimSpace(os.Getenv(envPrimaryAPIKey))
	}
	if key == "" {
		key = strings.TrimSpace(os.Getenv(envAltAPIKey))
	}
	if key == "" {
		k, err := promptForAPIKey()
		if err != nil {
			return err
		}
		key = k
	}
	if !strings.HasPrefix(key, "sk-relay-") {
		return errors.New("API key must start with sk-relay-")
	}

	envPath, err := envFilePath()
	if err != nil {
		return err
	}
	if err := writeEnvFile(envPath, key); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Saved API key to %s\n", envPath)
	fmt.Fprintln(os.Stderr, "Note: pi resolves $PI_RELAY_API_KEY at request time. Add")
	fmt.Fprintln(os.Stderr, "      `export PI_RELAY_API_KEY=...` to your shell rc if you have not.")

	if *skipRefresh {
		return nil
	}

	// Make the freshly saved key visible to refresh in this same process.
	_ = os.Setenv(envPrimaryAPIKey, key)
	return runRefresh(nil)
}

func runRemove(args []string) error {
	if err := flag.NewFlagSet("remove", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}
	modelsPath, err := getModelsPath()
	if err != nil {
		return err
	}
	root, err := readModelsJSON(modelsPath)
	if err != nil {
		return err
	}

	providers, _ := root["providers"].(map[string]any)
	if providers == nil {
		fmt.Fprintln(os.Stderr, "No providers section in", modelsPath, "— nothing to remove.")
		return nil
	}
	if _, ok := providers[providerName]; !ok {
		fmt.Fprintln(os.Stderr, "No relay provider in", modelsPath, "— nothing to remove.")
		return nil
	}
	delete(providers, providerName)
	root["providers"] = providers

	if err := writeModelsJSON(modelsPath, root); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Removed relay provider from %s\n", modelsPath)
	return nil
}

func runStatus(args []string) error {
	if err := flag.NewFlagSet("status", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}

	setupURL := getSetupURL()
	modelsPath, err := getModelsPath()
	if err != nil {
		return err
	}
	envPath, _ := envFilePath()

	keyPresent := "no"
	if k, _ := lookupAPIKey(); k != "" {
		keyPresent = "yes"
	}
	fmt.Fprintf(os.Stdout, "setup url:    %s\n", setupURL)
	fmt.Fprintf(os.Stdout, "models.json:  %s\n", modelsPath)
	if envPath != "" {
		fmt.Fprintf(os.Stdout, ".env:         %s\n", envPath)
	}
	fmt.Fprintf(os.Stdout, "api key set:  %s\n", keyPresent)

	root, err := readModelsJSON(modelsPath)
	if err != nil {
		fmt.Fprintf(os.Stdout, "relay:        models.json missing or unreadable (%v)\n", err)
		return nil
	}
	providers, _ := root["providers"].(map[string]any)
	relayAny, ok := providers[providerName]
	if !ok {
		fmt.Fprintln(os.Stdout, "relay:        not configured")
		return nil
	}
	raw, err := json.Marshal(relayAny)
	if err != nil {
		return err
	}
	relay, err := decodePiRelay(raw)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, "relay:        configured")
	fmt.Fprintf(os.Stdout, "  baseUrl:    %s\n", relay.BaseURL)
	fmt.Fprintf(os.Stdout, "  api:        %s\n", relay.API)
	fmt.Fprintf(os.Stdout, "  apiKey:     %s\n", relay.APIKey)
	fmt.Fprintf(os.Stdout, "  models:     %d\n", len(relay.Models))
	for _, m := range relay.Models {
		fmt.Fprintf(os.Stdout, "    - %s (%s)\n", m.ID, m.Name)
	}
	return nil
}

func runTest(args []string) error {
	if err := flag.NewFlagSet("test", flag.ContinueOnError).Parse(args); err != nil {
		return err
	}
	apiKey, err := requireAPIKey()
	if err != nil {
		return err
	}
	modelsPath, err := getModelsPath()
	if err != nil {
		return err
	}
	root, err := readModelsJSON(modelsPath)
	if err != nil {
		return err
	}
	providers, _ := root["providers"].(map[string]any)
	relayAny, ok := providers[providerName]
	if !ok {
		return errors.New("relay provider not configured — run `update-models refresh` first")
	}
	raw, err := json.Marshal(relayAny)
	if err != nil {
		return err
	}
	relay, err := decodePiRelay(raw)
	if err != nil {
		return err
	}
	if relay.BaseURL == "" || len(relay.Models) == 0 {
		return errors.New("relay provider missing baseUrl or models")
	}

	model := relay.Models[0].ID
	url := strings.TrimRight(relay.BaseURL, "/") + "/chat/completions"
	body := map[string]any{
		"model":    model,
		"stream":   false,
		"messages": []map[string]string{{"role": "user", "content": "ping"}},
	}
	payload, _ := json.Marshal(body)

	fmt.Fprintf(os.Stderr, "POST %s (model=%s)\n", url, model)
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("HTTP %d from chat/completions: %s", resp.StatusCode, truncate(string(respBody), 400))
	}
	fmt.Fprintf(os.Stdout, "ok: %s responded with HTTP %d\n", model, resp.StatusCode)
	return nil
}

// ---------- HTTP ----------

func fetchConfig(url, apiKey string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reach %s: %w", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return nil, fmt.Errorf("%s rejected the API key (HTTP %d)", url, resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("HTTP %d from %s: %s", resp.StatusCode, url, truncate(string(body), 200))
	}
	return body, nil
}

// ---------- OpenCode -> pi translation ----------

// OpenCode response shape (subset we care about — extra fields are ignored).
type opencodeCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

type opencodeLimit struct {
	Context int `json:"context"`
	Output  int `json:"output"`
}

type opencodeModalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

type opencodeModelConfig struct {
	Name       string                     `json:"name"`
	Cost       opencodeCost               `json:"cost"`
	Limit      opencodeLimit              `json:"limit"`
	Modalities opencodeModalities         `json:"modalities"`
	Variants   map[string]json.RawMessage `json:"variants,omitempty"`
}

// parseOpenCodeRelay validates the OpenCode payload and translates it into
// pi's provider shape. It tolerates a `{ "data": { ... } }` envelope.
//
// Model order is preserved by streaming `provider.relay.models` with a
// json.Decoder — Go maps would otherwise lose the server's name-sorted order.
func parseOpenCodeRelay(body []byte) (piRelay, error) {
	// Optionally unwrap `{ "data": { ... } }`.
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return piRelay{}, fmt.Errorf("parse response: %w", err)
	}
	if dataRaw, ok := top["data"]; ok {
		var inner map[string]json.RawMessage
		if err := json.Unmarshal(dataRaw, &inner); err == nil {
			if _, ok := inner["provider"]; ok {
				top = inner
			}
		}
	}
	providerRaw, ok := top["provider"]
	if !ok {
		return piRelay{}, errors.New("response missing 'provider' (expected OpenCode shape)")
	}
	var provider map[string]json.RawMessage
	if err := json.Unmarshal(providerRaw, &provider); err != nil {
		return piRelay{}, fmt.Errorf("parse provider: %w", err)
	}
	relayRaw, ok := provider[providerName]
	if !ok {
		return piRelay{}, errors.New("response missing 'provider.relay'")
	}

	var relay struct {
		Options struct {
			BaseURL string `json:"baseURL"`
		} `json:"options"`
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(relayRaw, &relay); err != nil {
		return piRelay{}, fmt.Errorf("parse provider.relay: %w", err)
	}
	if relay.Options.BaseURL == "" {
		return piRelay{}, errors.New("provider.relay.options.baseURL is empty")
	}

	models, err := decodeOrderedModels(relay.Models)
	if err != nil {
		return piRelay{}, err
	}
	if len(models) == 0 {
		return piRelay{}, errors.New("provider.relay.models is empty")
	}

	piModels := make([]piModel, 0, len(models))
	for _, m := range models {
		piModels = append(piModels, translateModel(m))
	}

	return piRelay{
		BaseURL: relay.Options.BaseURL,
		API:     piAPI,
		APIKey:  piAPIKey,
		Compat:  &piCompat{SupportsDeveloperRole: true},
		Models:  piModels,
	}, nil
}

type orderedOpenCodeModel struct {
	ID     string
	Config opencodeModelConfig
}

// decodeOrderedModels walks `provider.relay.models` as a JSON object while
// preserving insertion order. Go's `map[string]X` would scramble it.
func decodeOrderedModels(raw json.RawMessage) ([]orderedOpenCodeModel, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("parse provider.relay.models: %w", err)
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, errors.New("provider.relay.models is not a JSON object")
	}
	var out []orderedOpenCodeModel
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("parse provider.relay.models key: %w", err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("unexpected key type in provider.relay.models: %T", keyTok)
		}
		var cfg opencodeModelConfig
		if err := dec.Decode(&cfg); err != nil {
			return nil, fmt.Errorf("parse provider.relay.models[%q]: %w", key, err)
		}
		out = append(out, orderedOpenCodeModel{ID: key, Config: cfg})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return out, nil
}

// translateModel converts one OpenCode model entry into a pi model.
//
// The OpenCode response encodes reasoning support via `variants` (e.g.
// `["none","low","medium","high","max"]` for Claude-family models). pi
// expresses the same idea via `reasoning: true` plus a `thinkingLevelMap`.
// We sniff the variant set to pick the right map:
//
//   - has "max"   → Claude-family   → `{ minimal: null, xhigh: "max" }`
//   - has "xhigh" → GPT-family      → `{ minimal: null, xhigh: "xhigh" }`
//   - otherwise   → no reasoning toggle (matches pi's behavior for Gemini)
func translateModel(m orderedOpenCodeModel) piModel {
	cfg := m.Config

	input := cfg.Modalities.Input
	if len(input) == 0 {
		input = []string{"text"}
	}

	pm := piModel{
		ID:            m.ID,
		Name:          cfg.Name,
		ContextWindow: cfg.Limit.Context,
		MaxTokens:     cfg.Limit.Output,
		Input:         input,
		Cost: piCost{
			Input:      cfg.Cost.Input,
			Output:     cfg.Cost.Output,
			CacheRead:  cfg.Cost.CacheRead,
			CacheWrite: cfg.Cost.CacheWrite,
		},
	}

	switch {
	case hasVariant(cfg.Variants, "max"):
		pm.Reasoning = boolPtr(true)
		pm.ThinkingLevelMap = map[string]any{
			"minimal": nil,
			"xhigh":   "max",
		}
	case hasVariant(cfg.Variants, "xhigh"):
		pm.Reasoning = boolPtr(true)
		pm.ThinkingLevelMap = map[string]any{
			"minimal": nil,
			"xhigh":   "xhigh",
		}
	}

	return pm
}

func hasVariant(variants map[string]json.RawMessage, name string) bool {
	if variants == nil {
		return false
	}
	_, ok := variants[name]
	return ok
}

// ---------- pi-shape provider/model types ----------

type piCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type piModel struct {
	ID               string         `json:"id"`
	Name             string         `json:"name,omitempty"`
	Reasoning        *bool          `json:"reasoning,omitempty"`
	ThinkingLevelMap map[string]any `json:"thinkingLevelMap,omitempty"`
	ContextWindow    int            `json:"contextWindow,omitempty"`
	MaxTokens        int            `json:"maxTokens,omitempty"`
	Input            []string       `json:"input,omitempty"`
	Cost             piCost         `json:"cost"`
}

type piCompat struct {
	SupportsDeveloperRole bool `json:"supportsDeveloperRole"`
}

type piRelay struct {
	BaseURL string    `json:"baseUrl"`
	API     string    `json:"api"`
	APIKey  string    `json:"apiKey"`
	Compat  *piCompat `json:"compat,omitempty"`
	Models  []piModel `json:"models"`
}

func decodePiRelay(raw json.RawMessage) (piRelay, error) {
	var r piRelay
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, fmt.Errorf("parse providers.relay: %w", err)
	}
	return r, nil
}

func boolPtr(v bool) *bool { return &v }

// ---------- models.json read/merge/write ----------

func readModelsJSON(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]any{}, nil
	}
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if root == nil {
		root = map[string]any{}
	}
	return root, nil
}

func writeModelsJSON(path string, root map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(path, out, 0o644)
}

// mergeRelay swaps in the new `relay` provider, leaving any other providers
// in place. The pi relay value is stored as json.RawMessage in the in-memory
// map so the model order from translation is preserved verbatim through the
// final marshal.
func mergeRelay(path string, relay piRelay) error {
	root, err := readModelsJSON(path)
	if err != nil {
		return err
	}
	relayBytes, err := json.Marshal(relay)
	if err != nil {
		return err
	}
	providers, _ := root["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
	}
	providers[providerName] = json.RawMessage(relayBytes)
	root["providers"] = providers
	return writeModelsJSON(path, root)
}

func printRelaySummary(w io.Writer, modelsPath string, relay piRelay) {
	fmt.Fprintf(w, "relay configured at %s\n", modelsPath)
	fmt.Fprintf(w, "  baseUrl: %s\n", relay.BaseURL)
	fmt.Fprintf(w, "  api:     %s\n", relay.API)
	fmt.Fprintf(w, "  models:  %d\n", len(relay.Models))
	for _, m := range relay.Models {
		fmt.Fprintf(w, "    - %s (%s)\n", m.ID, m.Name)
	}
}

// ---------- API key + .env ----------

func requireAPIKey() (string, error) {
	key, src := lookupAPIKey()
	if key == "" {
		return "", fmt.Errorf("no API key set (export %s or %s, or put %s=... in a .env next to the binary)", envPrimaryAPIKey, envAltAPIKey, envPrimaryAPIKey)
	}
	if !strings.HasPrefix(key, "sk-relay-") {
		return "", fmt.Errorf("API key from %s does not start with sk-relay-", src)
	}
	return key, nil
}

// lookupAPIKey resolves the API key in priority order:
//  1. RELAY_API_KEY env
//  2. PI_RELAY_API_KEY env
//  3. .env file next to the executable (KEY=VALUE per line)
//
// Returns the key and a label describing where it came from, or "" and ""
// when nothing is set.
func lookupAPIKey() (string, string) {
	if v := strings.TrimSpace(os.Getenv(envPrimaryAPIKey)); v != "" {
		return v, "$" + envPrimaryAPIKey
	}
	if v := strings.TrimSpace(os.Getenv(envAltAPIKey)); v != "" {
		return v, "$" + envAltAPIKey
	}
	envPath, err := envFilePath()
	if err != nil {
		return "", ""
	}
	f, err := os.Open(envPath)
	if err != nil {
		return "", ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		if k != envPrimaryAPIKey && k != envAltAPIKey {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		if v != "" {
			return v, envPath
		}
	}
	return "", ""
}

func envFilePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(exe))
	if err != nil {
		dir = filepath.Dir(exe)
	}
	return filepath.Join(dir, ".env"), nil
}

func writeEnvFile(path, apiKey string) error {
	contents := fmt.Sprintf("%s=%s\n", envPrimaryAPIKey, apiKey)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func promptForAPIKey() (string, error) {
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return "", errors.New("API key required (pass --api-key or set RELAY_API_KEY)")
	}
	defer tty.Close()
	fmt.Fprint(tty, "Relay API key (sk-relay-...): ")
	scanner := bufio.NewScanner(tty)
	if !scanner.Scan() {
		return "", errors.New("no input read from /dev/tty")
	}
	v := strings.TrimSpace(scanner.Text())
	if v == "" {
		return "", errors.New("API key cannot be empty")
	}
	return v, nil
}

// ---------- env / paths ----------

func getSetupURL() string {
	if v := strings.TrimSpace(os.Getenv(envSetupURL)); v != "" {
		return v
	}
	return defaultSetupURL
}

func getModelsPath() (string, error) {
	if v := strings.TrimSpace(os.Getenv(envModelsPath)); v != "" {
		return expandHome(v)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pi", "agent", "models.json"), nil
}

func expandHome(p string) (string, error) {
	if !strings.HasPrefix(p, "~") {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if p == "~" {
		return home, nil
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:]), nil
	}
	return p, nil
}

// ---------- helpers ----------

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
