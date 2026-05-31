// websearch queries a SearXNG instance via its JSON API and prints the
// results as plain text for the agent to consume.
//
// Usage:
//
//	websearch <query> [--count N] [--lang CODE] [--time RANGE]
//	          [--category CAT] [--engines LIST] [--page N]
//	          [--safe 0|1|2] [--json]
//
// The SearXNG base URL is read from $SEARXNG_URL (or a `.env` next to the
// binary). An optional bearer token for protected instances is read from
// $SEARXNG_API_KEY the same way.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	urlEnv = "SEARXNG_URL"
	keyEnv = "SEARXNG_API_KEY"
)

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  websearch <query> [options]

Options:
  --count N         Max results to print (default 10).
  --lang CODE       Search language, e.g. en, ko, de (default: instance default).
  --time RANGE      Time filter: day, week, month, year.
  --category CAT    Category: general, news, images, videos, science, it, ...
  --engines LIST    Comma-separated engines, e.g. google,bing,duckduckgo.
  --page N          Result page number (default 1).
  --safe 0|1|2      Safe search: 0=off, 1=moderate, 2=strict.
  --json            Print the raw SearXNG JSON response instead of text.

Config:
  SEARXNG_URL       Base URL of the SearXNG instance (required).
  SEARXNG_API_KEY   Optional bearer token for protected instances.
  Both fall back to a KEY=VALUE .env next to the binary.`)
}

type options struct {
	query    string
	count    int
	lang     string
	timeR    string
	category string
	engines  string
	page     int
	safe     string
	rawJSON  bool
}

func parseArgs(args []string) (*options, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("query required")
	}
	opts := &options{query: args[0], count: 10, page: 1}
	args = args[1:]

	needValue := func(flag string, rest []string) (string, []string, error) {
		if len(rest) == 0 {
			return "", nil, fmt.Errorf("%s: value required", flag)
		}
		return rest[0], rest[1:], nil
	}

	for len(args) > 0 {
		flag := args[0]
		args = args[1:]
		switch flag {
		case "--count":
			v, rest, err := needValue("--count", args)
			if err != nil {
				return nil, err
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				return nil, fmt.Errorf("--count: positive integer required")
			}
			opts.count = n
			args = rest
		case "--lang":
			v, rest, err := needValue("--lang", args)
			if err != nil {
				return nil, err
			}
			opts.lang = v
			args = rest
		case "--time":
			v, rest, err := needValue("--time", args)
			if err != nil {
				return nil, err
			}
			opts.timeR = v
			args = rest
		case "--category":
			v, rest, err := needValue("--category", args)
			if err != nil {
				return nil, err
			}
			opts.category = v
			args = rest
		case "--engines":
			v, rest, err := needValue("--engines", args)
			if err != nil {
				return nil, err
			}
			opts.engines = v
			args = rest
		case "--page":
			v, rest, err := needValue("--page", args)
			if err != nil {
				return nil, err
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				return nil, fmt.Errorf("--page: positive integer required")
			}
			opts.page = n
			args = rest
		case "--safe":
			v, rest, err := needValue("--safe", args)
			if err != nil {
				return nil, err
			}
			if v != "0" && v != "1" && v != "2" {
				return nil, fmt.Errorf("--safe: must be 0, 1, or 2")
			}
			opts.safe = v
			args = rest
		case "--json":
			opts.rawJSON = true
		case "-h", "--help":
			usage()
			os.Exit(0)
		default:
			return nil, fmt.Errorf("unknown flag: %s", flag)
		}
	}
	return opts, nil
}

type searchResult struct {
	URL           string `json:"url"`
	Title         string `json:"title"`
	Content       string `json:"content"`
	Engine        string `json:"engine"`
	PublishedDate string `json:"publishedDate"`
	Score         float64 `json:"score"`
	Category      string `json:"category"`
}

type infobox struct {
	Infobox string `json:"infobox"`
	Content string `json:"content"`
}

type searchResponse struct {
	Query               string         `json:"query"`
	NumberOfResults     float64        `json:"number_of_results"`
	Results             []searchResult `json:"results"`
	Answers             []json.RawMessage `json:"answers"`
	Suggestions         []string       `json:"suggestions"`
	Infoboxes           []infobox      `json:"infoboxes"`
	UnresponsiveEngines [][]any        `json:"unresponsive_engines"`
}

func main() {
	opts, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		usage()
		os.Exit(1)
	}

	base := lookupEnv(urlEnv)
	if base == "" {
		fmt.Fprintf(os.Stderr, "%s is required (export it, or put %s=... in a .env next to the binary)\n", urlEnv, urlEnv)
		os.Exit(1)
	}

	endpoint, err := buildURL(base, opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	body, err := fetch(endpoint, lookupEnv(keyEnv))
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}

	if opts.rawJSON {
		os.Stdout.Write(body)
		if len(body) > 0 && body[len(body)-1] != '\n' {
			fmt.Fprintln(os.Stdout)
		}
		return
	}

	var resp searchResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		fmt.Fprintln(os.Stderr, "error: decoding response:", err)
		fmt.Fprintln(os.Stderr, "hint: the instance may not have the JSON format enabled (search.formats: [json] in settings.yml)")
		os.Exit(1)
	}

	printResults(os.Stdout, &resp, opts)
}

// buildURL assembles the SearXNG /search request URL from base + options.
func buildURL(base string, opts *options) (string, error) {
	u, err := url.Parse(strings.TrimRight(base, "/") + "/search")
	if err != nil {
		return "", fmt.Errorf("invalid %s: %w", urlEnv, err)
	}
	q := url.Values{}
	q.Set("q", opts.query)
	q.Set("format", "json")
	if opts.lang != "" {
		q.Set("language", opts.lang)
	}
	if opts.timeR != "" {
		q.Set("time_range", opts.timeR)
	}
	if opts.category != "" {
		q.Set("categories", opts.category)
	}
	if opts.engines != "" {
		q.Set("engines", opts.engines)
	}
	if opts.page > 1 {
		q.Set("pageno", strconv.Itoa(opts.page))
	}
	if opts.safe != "" {
		q.Set("safesearch", opts.safe)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func fetch(endpoint, token string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "pi-websearch-skill/1.0")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > 300 {
			snippet = snippet[:300] + "…"
		}
		return nil, fmt.Errorf("HTTP %d from %s: %s", resp.StatusCode, endpoint, snippet)
	}
	return body, nil
}

func printResults(w io.Writer, resp *searchResponse, opts *options) {
	// Infoboxes first — they're usually the most direct answer.
	for _, ib := range resp.Infoboxes {
		if strings.TrimSpace(ib.Content) == "" {
			continue
		}
		fmt.Fprintf(w, "[infobox] %s\n%s\n\n", strings.TrimSpace(ib.Infobox), strings.TrimSpace(ib.Content))
	}

	if len(resp.Results) == 0 {
		fmt.Fprintf(w, "No results for %q.\n", opts.query)
		if len(resp.Suggestions) > 0 {
			fmt.Fprintf(w, "Suggestions: %s\n", strings.Join(resp.Suggestions, ", "))
		}
		return
	}

	n := opts.count
	if n > len(resp.Results) {
		n = len(resp.Results)
	}
	fmt.Fprintf(w, "Top %d of %d result(s) for %q:\n\n", n, len(resp.Results), opts.query)

	for i, r := range resp.Results[:n] {
		fmt.Fprintf(w, "%d. %s\n   %s\n", i+1, strings.TrimSpace(r.Title), r.URL)
		if c := strings.TrimSpace(r.Content); c != "" {
			fmt.Fprintf(w, "   %s\n", collapse(c))
		}
		meta := r.Engine
		if r.PublishedDate != "" {
			meta = strings.TrimSpace(meta + " · " + r.PublishedDate)
		}
		if meta != "" {
			fmt.Fprintf(w, "   (%s)\n", meta)
		}
		fmt.Fprintln(w)
	}

	if len(resp.Suggestions) > 0 {
		fmt.Fprintf(w, "Related: %s\n", strings.Join(resp.Suggestions, ", "))
	}
}

// collapse flattens internal whitespace/newlines so a snippet prints on one
// indented line.
func collapse(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// lookupEnv resolves a config value: environment variable first, then a
// KEY=VALUE line in a `.env` next to the (symlink-resolved) binary.
func lookupEnv(key string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(exe))
	if err != nil {
		dir = filepath.Dir(exe)
	}
	f, err := os.Open(filepath.Join(dir, ".env"))
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != key {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		return v
	}
	return ""
}
