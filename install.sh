#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="${PHONE_CLI_BRIDGE_INSTALL_DIR:-$HOME/my_repos/phone-cli-bridge}"
REPO_URL="${PHONE_CLI_BRIDGE_REPO_URL:-https://github.com/qteqpid/phone-cli-bridge.git}"
ALIAS_NAME="${PHONE_CLI_BRIDGE_ALIAS:-phone-bridge}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  CYAN="$(printf '\033[36m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  DIM=""
  GREEN=""
  YELLOW=""
  RED=""
  CYAN=""
  RESET=""
fi

say() {
  printf '%s\n' "$1"
}

say_err() {
  printf '%s\n' "$1" >&2
}

banner() {
  printf '\n%sPhone CLI Bridge Installer%s\n' "$BOLD" "$RESET"
  printf '%s\n' "${DIM}--------------------------${RESET}"
}

step() {
  printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"
}

info() {
  printf '  %sINFO%s %s\n' "$CYAN" "$RESET" "$1"
}

ok() {
  printf '  %sOK%s %s\n' "$GREEN" "$RESET" "$1"
}

warn() {
  printf '  %sWARN%s %s\n' "$YELLOW" "$RESET" "$1"
}

error() {
  printf '  %sERROR%s %s\n' "$RED" "$RESET" "$1" >&2
}

command_hint() {
  printf '  %s%s%s\n' "$CYAN" "$1" "$RESET"
}

confirm() {
  local prompt="$1"
  local answer

  while true; do
    printf '%s? %s[y/N]%s ' "$prompt" "$DIM" "$RESET" >&2
    IFS= read -r answer || answer=""
    if [[ ! -t 0 ]]; then
      printf '\n' >&2
    fi

    case "$answer" in
      y|Y|yes|YES|Yes)
        return 0
        ;;
      n|N|no|NO|No|"")
        return 1
        ;;
      *)
        error "Please answer y or n."
        ;;
    esac
  done
}

confirm_or_exit() {
  local prompt="$1"

  if ! confirm "$prompt"; then
    warn "Cancelled."
    exit 1
  fi
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    error "Phone CLI Bridge installer currently supports macOS only."
    exit 1
  fi
  ok "macOS detected"
}

default_shell_rc() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"

  case "$shell_name" in
    zsh)
      printf '%s\n' "$HOME/.zshrc"
      ;;
    bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        printf '%s\n' "$HOME/.bashrc"
      else
        printf '%s\n' "$HOME/.bash_profile"
      fi
      ;;
    fish)
      printf '%s\n' "$HOME/.config/fish/config.fish"
      ;;
    *)
      printf '%s\n' "$HOME/.profile"
      ;;
  esac
}

load_brew_env() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_homebrew() {
  load_brew_env
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew found"
    return
  fi

  warn "Homebrew not found"
  confirm_or_exit "Install Homebrew now"
  info "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew_env
  ok "Homebrew installed"
}

ensure_command() {
  local command_name="$1"
  local package_name="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$command_name found"
    return
  fi

  warn "$command_name not found"
  confirm_or_exit "Install $package_name with Homebrew now"
  info "Installing $package_name..."
  brew install "$package_name"
  ok "$package_name installed"
}

install_bridge() {
  local parent_dir
  parent_dir="$(dirname "$INSTALL_DIR")"

  if [[ ! -d "$parent_dir" ]]; then
    warn "Install parent directory does not exist: $parent_dir"
    confirm_or_exit "Create install parent directory $parent_dir"
    mkdir -p "$parent_dir"
    ok "Created $parent_dir"
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    if confirm "Phone CLI Bridge already exists in $INSTALL_DIR. Update it with git pull --ff-only"; then
      info "Updating Phone CLI Bridge in $INSTALL_DIR..."
      git -C "$INSTALL_DIR" pull --ff-only
      ok "Updated $INSTALL_DIR"
    else
      warn "Skipping update for $INSTALL_DIR"
    fi
    return
  fi

  if [[ -e "$INSTALL_DIR" ]]; then
    error "Install directory exists but is not a git checkout: $INSTALL_DIR"
    info "Set PHONE_CLI_BRIDGE_INSTALL_DIR to another path or remove the existing directory."
    exit 1
  fi

  confirm_or_exit "Clone Phone CLI Bridge from $REPO_URL to $INSTALL_DIR"
  info "Installing Phone CLI Bridge to $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned $INSTALL_DIR"
}

install_alias() {
  local begin_marker="# >>> phone-cli-bridge >>>"
  local end_marker="# <<< phone-cli-bridge <<<"
  local shell_rc="${PHONE_CLI_BRIDGE_SHELL_RC:-$(default_shell_rc)}"
  local shell_name
  local alias_line
  local block

  shell_name="$(basename "${SHELL:-}")"
  if [[ "$shell_name" == "fish" ]]; then
    alias_line="alias $ALIAS_NAME 'node \"$INSTALL_DIR/server.mjs\" -w \"\$PWD\"'"
  else
    alias_line="alias $ALIAS_NAME='node \"$INSTALL_DIR/server.mjs\" -w \"\$PWD\"'"
  fi

  block="$(printf '%s\n%s\n%s\n' "$begin_marker" "$alias_line" "$end_marker")"

  if ! confirm "Add or update $ALIAS_NAME alias in $shell_rc"; then
    warn "Skipping alias setup" >&2
    return 1
  fi

  mkdir -p "$(dirname "$shell_rc")"
  touch "$shell_rc"

  if grep -qF "$begin_marker" "$shell_rc"; then
    local tmp_file
    tmp_file="$(mktemp)"
    awk -v begin="$begin_marker" -v end="$end_marker" -v block="$block" '
      $0 == begin {
        print block
        in_block = 1
        next
      }
      $0 == end {
        in_block = 0
        next
      }
      !in_block {
        print
      }
    ' "$shell_rc" > "$tmp_file"
    mv "$tmp_file" "$shell_rc"
  else
    {
      printf '\n'
      printf '%s\n' "$block"
    } >> "$shell_rc"
  fi

  ok "Configured $ALIAS_NAME alias in $shell_rc" >&2
  printf '%s\n' "$shell_rc"
}

main() {
  local shell_rc
  local alias_installed=0

  banner
  step "[1/5] Checking system"
  ensure_macos
  step "[2/5] Checking Homebrew"
  ensure_homebrew
  step "[3/5] Checking dependencies"
  ensure_command git git
  ensure_command node node
  ensure_command tmux tmux
  step "[4/5] Installing bridge"
  install_bridge
  step "[5/5] Configuring shell"
  if shell_rc="$(install_alias)"; then
    alias_installed=1
  fi

  printf '\n%sDone.%s\n' "$BOLD" "$RESET"
  if [[ "$alias_installed" == "1" ]]; then
    info "Run this now to load the alias:"
    command_hint "source \"$shell_rc\""
    info "Then start it from any project directory:"
    command_hint "$ALIAS_NAME -r"
  else
    warn "Alias setup was skipped. Start it with:"
    command_hint "node \"$INSTALL_DIR/server.mjs\" -w \"\$PWD\" -r"
  fi
}

main "$@"
