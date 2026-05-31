SHELL := /bin/bash

# Where pi looks for skills and extensions.
SKILLS_DIR     ?= $(HOME)/.pi/agent/skills
EXTENSIONS_DIR ?= $(HOME)/.pi/agent/extensions

BIN_DIR := bin

# All skills + extensions tracked by this repo. Per-machine toggles live in
# `skills.local.json` next to the Makefile, e.g.:
#
#     { "ast-grep": false, "my-extension": false }
#
# Names are flat across skills and extensions. Anything missing from the
# file defaults to enabled. The file is gitignored.
ALL_SKILLS     := ast-grep context7 grep-search update-models websearch
# Extensions are TypeScript files or directories under `extensions/`. Each
# entry here must match either `extensions/<name>.ts` or `extensions/<name>/`
# (a directory containing `index.ts` or a `package.json` with `pi.extensions`).
ALL_EXTENSIONS := session-lock ui-cosmetics question goal telegram subagents btw
LOCAL_CFG      := skills.local.json

# Compute disabled set per category. Each call shells out to the helper
# script, which understands both the nested format and the legacy flat one
# (so the first install on a pre-migration file still honours `false`
# flips). The Makefile then filters by $(ALL_SKILLS) / $(ALL_EXTENSIONS) so
# stray legacy names that fall outside both categories don't accidentally
# disable anything new sharing their name.
DISABLED_SKILLS_RAW := $(strip $(shell \
  if [ -f $(LOCAL_CFG) ]; then \
    scripts/local-config.py disabled $(LOCAL_CFG) --kind skills 2>/dev/null; \
  fi))
DISABLED_EXTS_RAW := $(strip $(shell \
  if [ -f $(LOCAL_CFG) ]; then \
    scripts/local-config.py disabled $(LOCAL_CFG) --kind extensions 2>/dev/null; \
  fi))
DISABLED_SKILLS := $(filter $(ALL_SKILLS),$(DISABLED_SKILLS_RAW))
DISABLED_EXTS   := $(filter $(ALL_EXTENSIONS),$(DISABLED_EXTS_RAW))
DISABLED        := $(sort $(DISABLED_SKILLS) $(DISABLED_EXTS))

SKILLS     := $(filter-out $(DISABLED_SKILLS),$(ALL_SKILLS))
EXTENSIONS := $(filter-out $(DISABLED_EXTS),$(ALL_EXTENSIONS))
BINS       := $(addprefix $(BIN_DIR)/,$(SKILLS))

GOFLAGS := -trimpath
LDFLAGS := -s -w

.PHONY: all build install uninstall clean fmt vet test help status

all: build

help:
	@echo "Targets:"
	@echo "  build       build enabled skill binaries into $(BIN_DIR)/"
	@echo "  install     install enabled skills into $(SKILLS_DIR)/<name>/"
	@echo "              and enabled extensions into $(EXTENSIONS_DIR)/<name>/"
	@echo "              (disabled entries are removed from those dirs)"
	@echo "  uninstall   remove skills and extensions (preserves .env, node_modules)"
	@echo "  status      show enabled/disabled skills + extensions"
	@echo "  clean       remove $(BIN_DIR)/"
	@echo "  fmt vet test"
	@echo ""
	@echo "Toggle entries per-machine via $(LOCAL_CFG):"
	@echo "  {"
	@echo "    \"skills\":     { \"ast-grep\": false },"
	@echo "    \"extensions\": { \"my-extension\": false }"
	@echo "  }"
	@echo "  (legacy flat format is auto-migrated on next install)"

status:
	@echo "all skills:        $(ALL_SKILLS)"
	@echo "all extensions:    $(if $(ALL_EXTENSIONS),$(ALL_EXTENSIONS),<none>)"
	@echo "enabled skills:    $(if $(SKILLS),$(SKILLS),<none>)"
	@echo "enabled exts:      $(if $(EXTENSIONS),$(EXTENSIONS),<none>)"
	@echo "disabled:          $(if $(DISABLED),$(DISABLED),<none>)"
	@echo "config file:       $(LOCAL_CFG) $(if $(wildcard $(LOCAL_CFG)),(present),(missing — all enabled))"
	@echo "skills install:    $(SKILLS_DIR)"
	@echo "extensions install: $(EXTENSIONS_DIR)"

build: $(BINS)

# Rebuild a binary if any Go source under the project changes. Cheaper than
# tracking per-skill deps and good enough for a tiny tree.
GO_SRC := $(shell find . -type f -name '*.go' -not -path './$(BIN_DIR)/*' 2>/dev/null)

$(BIN_DIR)/%: $(GO_SRC) go.mod
	@mkdir -p $(BIN_DIR)
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $@ ./skills/$*

# Install: drop fresh SKILL.md + binary into $(SKILLS_DIR)/<name>/ for every
# enabled skill, and symlink each enabled extension into $(EXTENSIONS_DIR).
# Disabled entries are torn down so toggling off actually removes them from
# pi's registries. Sibling files in install dirs (.env, node_modules, etc.)
# are preserved across runs except when an entry is disabled.
install: build sync-config
	@for s in $(SKILLS); do \
	  dest="$(SKILLS_DIR)/$$s"; \
	  mkdir -p "$$dest"; \
	  cp skills/$$s/SKILL.md "$$dest/SKILL.md"; \
	  install -m 0755 $(BIN_DIR)/$$s "$$dest/$$s"; \
	  echo "installed skill $$s -> $$dest"; \
	done
	@for e in $(EXTENSIONS); do \
	  $(MAKE) --no-print-directory _install_extension EXT=$$e; \
	done
	@for n in $(DISABLED); do \
	  for d in "$(SKILLS_DIR)/$$n" "$(EXTENSIONS_DIR)/$$n" "$(EXTENSIONS_DIR)/$$n.ts"; do \
	    if [ -e "$$d" ] || [ -L "$$d" ]; then \
	      rm -rf "$$d"; \
	      echo "disabled $$n (removed $$d)"; \
	    fi; \
	  done; \
	done

# Reconcile $(LOCAL_CFG) with the names tracked by the Makefile on every
# install. See scripts/local-config.py for the full behavior contract
# (create, append-as-true, leave alone, migrate legacy flat format).
#
# This fires *after* DISABLED was computed at make parse time, but that's
# fine — we only ever add `true` entries here, never `false`, so the
# disabled set is still correct for this run.
.PHONY: sync-config
sync-config:
	@scripts/local-config.py sync $(LOCAL_CFG) \
	  --skills $(ALL_SKILLS) \
	  --extensions $(ALL_EXTENSIONS)

# Internal: install one extension. EXT=<name>. Prefers `extensions/<name>/`
# (directory style) over `extensions/<name>.ts` (single file).
#
# Extensions are symlinked (not copied) into $(EXTENSIONS_DIR) so edits in this
# repo take effect immediately — just `/reload` inside pi, no re-install. pi
# follows the symlink and runs the TS source directly via jiti. (Skills differ:
# they ship a built Go binary, so they are still copied.)
.PHONY: _install_extension
_install_extension:
	@repo=$$(pwd); \
	name="$(EXT)"; \
	src_dir="$$repo/extensions/$$name"; \
	src_file="$$repo/extensions/$$name.ts"; \
	mkdir -p "$(EXTENSIONS_DIR)"; \
	if [ -d "$$src_dir" ]; then \
	  dest="$(EXTENSIONS_DIR)/$$name"; \
	  rm -rf "$$dest"; \
	  ln -s "$$src_dir" "$$dest"; \
	  echo "linked extension $$name -> $$dest"; \
	elif [ -f "$$src_file" ]; then \
	  dest="$(EXTENSIONS_DIR)/$$name.ts"; \
	  rm -rf "$$dest"; \
	  ln -s "$$src_file" "$$dest"; \
	  echo "linked extension $$name -> $$dest"; \
	else \
	  echo "warning: extension $$name not found at $$src_dir or $$src_file" >&2; \
	fi

uninstall:
	@for s in $(ALL_SKILLS); do \
	  dest="$(SKILLS_DIR)/$$s"; \
	  rm -f "$$dest/SKILL.md" "$$dest/$$s"; \
	  echo "removed skill $$s from $$dest (kept .env and other state)"; \
	done
	@for e in $(ALL_EXTENSIONS); do \
	  for d in "$(EXTENSIONS_DIR)/$$e" "$(EXTENSIONS_DIR)/$$e.ts"; do \
	    if [ -L "$$d" ]; then \
	      rm "$$d"; \
	      echo "removed extension $$e link at $$d"; \
	    elif [ -f "$$d" ]; then \
	      rm "$$d"; \
	      echo "removed extension $$e at $$d"; \
	    elif [ -d "$$d" ]; then \
	      rm -rf "$$d"; \
	      echo "removed extension $$e at $$d"; \
	    fi; \
	  done; \
	done

clean:
	rm -rf $(BIN_DIR)

fmt:
	go fmt ./...

vet:
	go vet ./...

test:
	go test ./...
