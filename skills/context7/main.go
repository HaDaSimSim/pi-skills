// context7 queries the Context7 MCP server for library documentation.
//
// Subcommands:
//
//	context7 resolve <library_name> [query]
//	context7 query <library_id> <question>
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mingeon.me/pi-skills/internal/mcp"
)

const (
	endpoint  = "https://mcp.context7.com/mcp"
	apiKeyEnv = "CONTEXT7_API_KEY"
)

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  context7 resolve <library_name> [query]  Find library IDs by name
  context7 query <library_id> <question>   Fetch docs for a resolved library`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	apiKey := lookupAPIKey()
	if apiKey == "" {
		fmt.Fprintf(os.Stderr, "%s is required (export it, or put %s=... in a .env next to the binary)\n", apiKeyEnv, apiKeyEnv)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	client := mcp.New(endpoint, map[string]string{
		apiKeyEnv: apiKey,
	})
	if err := client.Initialize(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "initialize:", err)
		os.Exit(1)
	}

	switch os.Args[1] {
	case "resolve":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "resolve: library_name required")
			usage()
			os.Exit(1)
		}
		name := os.Args[2]
		query := name
		if len(os.Args) >= 4 {
			query = os.Args[3]
		}
		runTool(ctx, client, "resolve-library-id", map[string]any{
			"libraryName": name,
			"query":       query,
		})

	case "query":
		if len(os.Args) < 4 {
			fmt.Fprintln(os.Stderr, "query: library_id and question required")
			usage()
			os.Exit(1)
		}
		// Note: the upstream `query-docs` tool no longer accepts a token
		// budget; ignore extra args for backwards compatibility.
		runTool(ctx, client, "query-docs", map[string]any{
			"libraryId": os.Args[2],
			"query":     os.Args[3],
		})

	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage()
		os.Exit(1)
	}
}

func runTool(ctx context.Context, client *mcp.Client, name string, args map[string]any) {
	content, err := client.CallTool(ctx, name, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	mcp.PrintTextContent(os.Stdout, content)
}

// lookupAPIKey returns the Context7 API key. Resolution order:
//  1. process env (CONTEXT7_API_KEY)
//  2. .env file next to the executable, KEY=VALUE per line
//
// The .env path lets pi users drop a file at
// ~/.pi/agent/skills/context7/.env without exporting anything in their shell.
func lookupAPIKey() string {
	if v := os.Getenv(apiKeyEnv); v != "" {
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
		if !ok {
			continue
		}
		if strings.TrimSpace(k) != apiKeyEnv {
			continue
		}
		v = strings.TrimSpace(v)
		// strip optional surrounding quotes
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		return v
	}
	return ""
}
