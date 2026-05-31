// ast-grep is a thin wrapper around the system `ast-grep` CLI, exposing two
// subcommands tuned for agent use: `search` and `replace`. Both shell out to
// the local binary; this wrapper just curates the flag surface and ensures
// deterministic output (no color, stable error reporting).
//
// Usage:
//
//	ast-grep search  <pattern> --lang <lang> [paths...]
//	                 [--glob <g>]... [--context <n>]
//	ast-grep replace <pattern> <rewrite> --lang <lang> [paths...]
//	                 [--glob <g>]... [--apply]
//
// The wrapper requires `ast-grep` (or `sg`) to be on PATH. Patterns use
// ast-grep's AST syntax (`$VAR`, `$$$`) — see SKILL.md for details.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

func usage() {
	fmt.Fprintln(os.Stderr, `Usage:
  ast-grep search  <pattern> --lang <lang> [paths...] [--glob <g>]... [--context <n>]
  ast-grep replace <pattern> <rewrite> --lang <lang> [paths...] [--glob <g>]... [--apply]

Patterns use ast-grep AST syntax ($VAR for one node, $$$ for many). Not regex.`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	sub := os.Args[1]
	args := os.Args[2:]

	switch sub {
	case "search":
		if err := runSearch(args); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "replace":
		if err := runReplace(args); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", sub)
		usage()
		os.Exit(1)
	}
}

type searchOpts struct {
	pattern string
	lang    string
	paths   []string
	globs   []string
	context string // empty = no context flag
}

func parseSearch(args []string) (*searchOpts, error) {
	if len(args) == 0 {
		return nil, errors.New("pattern required")
	}
	o := &searchOpts{pattern: args[0]}
	args = args[1:]
	for len(args) > 0 {
		flag := args[0]
		args = args[1:]
		switch flag {
		case "--lang", "-l":
			v, rest, err := needValue(flag, args)
			if err != nil {
				return nil, err
			}
			o.lang, args = v, rest
		case "--glob":
			v, rest, err := needValue(flag, args)
			if err != nil {
				return nil, err
			}
			o.globs = append(o.globs, v)
			args = rest
		case "--context", "-C":
			v, rest, err := needValue(flag, args)
			if err != nil {
				return nil, err
			}
			o.context, args = v, rest
		case "-h", "--help":
			usage()
			os.Exit(0)
		default:
			if len(flag) > 0 && flag[0] == '-' {
				return nil, fmt.Errorf("unknown flag: %s", flag)
			}
			o.paths = append(o.paths, flag)
		}
	}
	if o.lang == "" {
		return nil, errors.New("--lang required")
	}
	return o, nil
}

func runSearch(args []string) error {
	o, err := parseSearch(args)
	if err != nil {
		return err
	}
	cmdArgs := []string{"run", "-p", o.pattern, "-l", o.lang, "--color", "never", "--heading", "always"}
	for _, g := range o.globs {
		cmdArgs = append(cmdArgs, "--globs", g)
	}
	if o.context != "" {
		cmdArgs = append(cmdArgs, "-C", o.context)
	}
	if len(o.paths) > 0 {
		cmdArgs = append(cmdArgs, o.paths...)
	}
	return exec_run(cmdArgs)
}

type replaceOpts struct {
	pattern string
	rewrite string
	lang    string
	paths   []string
	globs   []string
	apply   bool
}

func parseReplace(args []string) (*replaceOpts, error) {
	if len(args) < 2 {
		return nil, errors.New("pattern and rewrite required")
	}
	o := &replaceOpts{pattern: args[0], rewrite: args[1]}
	args = args[2:]
	for len(args) > 0 {
		flag := args[0]
		args = args[1:]
		switch flag {
		case "--lang", "-l":
			v, rest, err := needValue(flag, args)
			if err != nil {
				return nil, err
			}
			o.lang, args = v, rest
		case "--glob":
			v, rest, err := needValue(flag, args)
			if err != nil {
				return nil, err
			}
			o.globs = append(o.globs, v)
			args = rest
		case "--apply":
			o.apply = true
		case "-h", "--help":
			usage()
			os.Exit(0)
		default:
			if len(flag) > 0 && flag[0] == '-' {
				return nil, fmt.Errorf("unknown flag: %s", flag)
			}
			o.paths = append(o.paths, flag)
		}
	}
	if o.lang == "" {
		return nil, errors.New("--lang required")
	}
	return o, nil
}

func runReplace(args []string) error {
	o, err := parseReplace(args)
	if err != nil {
		return err
	}
	cmdArgs := []string{"run", "-p", o.pattern, "-r", o.rewrite, "-l", o.lang, "--color", "never", "--heading", "always"}
	for _, g := range o.globs {
		cmdArgs = append(cmdArgs, "--globs", g)
	}
	if o.apply {
		cmdArgs = append(cmdArgs, "-U")
	}
	if len(o.paths) > 0 {
		cmdArgs = append(cmdArgs, o.paths...)
	}
	return exec_run(cmdArgs)
}

// exec_run shells out to ast-grep (or sg) and forwards stdio. The command's
// exit code propagates as our exit code so pi sees real success/failure.
func exec_run(args []string) error {
	bin, err := findAstGrep()
	if err != nil {
		return err
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			os.Exit(ee.ExitCode())
		}
		return err
	}
	return nil
}

func findAstGrep() (string, error) {
	for _, name := range []string{"ast-grep", "sg"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", errors.New("ast-grep not found on PATH (install via `brew install ast-grep` or see https://ast-grep.github.io)")
}

func needValue(flag string, rest []string) (string, []string, error) {
	if len(rest) == 0 {
		return "", nil, fmt.Errorf("%s: value required", flag)
	}
	return rest[0], rest[1:], nil
}
