// grep-search searches public GitHub code via the grep.app MCP server.
//
// Usage:
//
//	grep-search <query> [--lang <lang>] [--repo <owner/repo>] [--path <path>]
//	            [--regexp] [--case] [--words]
//
// `--lang` may be repeated to OR multiple languages.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"mingeon.me/pi-skills/internal/mcp"
)

const endpoint = "https://mcp.grep.app"

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  grep-search <query> [--lang <lang>] [--repo <owner/repo>] [--path <path>]
                      [--regexp] [--case] [--words]`)
}

type options struct {
	query  string
	langs  []string
	repo   string
	path   string
	regexp bool
	caseS  bool
	words  bool
}

func parseArgs(args []string) (*options, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("query required")
	}
	opts := &options{query: args[0]}
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
		case "--lang":
			v, rest, err := needValue("--lang", args)
			if err != nil {
				return nil, err
			}
			opts.langs = append(opts.langs, v)
			args = rest
		case "--repo":
			v, rest, err := needValue("--repo", args)
			if err != nil {
				return nil, err
			}
			opts.repo = v
			args = rest
		case "--path":
			v, rest, err := needValue("--path", args)
			if err != nil {
				return nil, err
			}
			opts.path = v
			args = rest
		case "--regexp":
			opts.regexp = true
		case "--case":
			opts.caseS = true
		case "--words":
			opts.words = true
		case "-h", "--help":
			usage()
			os.Exit(0)
		default:
			return nil, fmt.Errorf("unknown flag: %s", flag)
		}
	}
	return opts, nil
}

func main() {
	opts, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		usage()
		os.Exit(1)
	}

	args := map[string]any{
		"query":           opts.query,
		"useRegexp":       opts.regexp,
		"matchCase":       opts.caseS,
		"matchWholeWords": opts.words,
	}
	if opts.repo != "" {
		args["repo"] = opts.repo
	}
	if opts.path != "" {
		args["path"] = opts.path
	}
	if len(opts.langs) > 0 {
		args["language"] = opts.langs
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// grep.app's MCP server doesn't require a session id, but it does want
	// the `notifications/initialized` ping before tool calls.
	client := mcp.New(endpoint, nil)
	if err := client.NotifyInitialized(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "initialize:", err)
		os.Exit(1)
	}

	content, err := client.CallTool(ctx, "searchGitHub", args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	mcp.PrintTextContent(os.Stdout, content)
}
