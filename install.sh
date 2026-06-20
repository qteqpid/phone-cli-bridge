#!/usr/bin/env bash

set -euo pipefail

INSTALL_DIR="${PHONE_CLI_BRIDGE_INSTALL_DIR:-$HOME/my_repos/phone-cli-bridge}"
REPO_URL="${PHONE_CLI_BRIDGE_REPO_URL:-https://github.com/qteqpid/phone-cli-bridge.git}"
ALIAS_NAME="${PHONE_CLI_BRIDGE_ALIAS:-phone-bridge}"

say() {
  printf '%s\n' "$1"
}

say_err() {
  printf '%s\n' "$1" >&2
}

confirm() {
  local prompt="$1"
  local answer

  while true; do
    printf '%s [y/N] ' "$prompt" >&2
    IFS= read -r answer || answer=""

    case "$answer" in
      y|Y|yes|YES|Yes)
        return 0
        ;;
      n|N|no|NO|No|"")
        return 1
        ;;
      *)
        say_err "Please answer y or n."
        ;;
    esac
  done
}

confirm_or_exit() {
  local prompt="$1"

  if ! confirm "$prompt"; then
    say "Cancelled."
    exit 1
  fi
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    say "Phone CLI Bridge installer currently supports macOS only."
    exit 1
  fi
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
    return
  fi

  confirm_or_exit "Homebrew is not installed. Install Homebrew now?"
  say "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew_env
}

ensure_command() {
  local command_name="$1"
  local package_name="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    return
  fi

  confirm_or_exit "$command_name is not installed. Install $package_name with Homebrew now?"
  say "Installing $package_name..."
  brew install "$package_name"
}

install_bridge() {
  local parent_dir
  parent_dir="$(dirname "$INSTALL_DIR")"

  if [[ ! -d "$parent_dir" ]]; then
    confirm_or_exit "Create install parent directory $parent_dir?"
    mkdir -p "$parent_dir"
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    if confirm "Phone CLI Bridge already exists in $INSTALL_DIR. Update it with git pull --ff-only?"; then
      say "Updating Phone CLI Bridge in $INSTALL_DIR..."
      git -C "$INSTALL_DIR" pull --ff-only
    else
      say "Skipping update for $INSTALL_DIR."
    fi
    return
  fi

  if [[ -e "$INSTALL_DIR" ]]; then
    say "Install directory exists but is not a git checkout: $INSTALL_DIR"
    say "Set PHONE_CLI_BRIDGE_INSTALL_DIR to another path or remove the existing directory."
    exit 1
  fi

  confirm_or_exit "Clone Phone CLI Bridge from $REPO_URL to $INSTALL_DIR?"
  say "Installing Phone CLI Bridge to $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
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

  if ! confirm "Add or update $ALIAS_NAME alias in $shell_rc?"; then
    say "Skipping alias setup." >&2
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

  printf '%s\n' "$shell_rc"
}

main() {
  local shell_rc
  local alias_installed=0

  ensure_macos
  ensure_homebrew
  ensure_command git git
  ensure_command node node
  ensure_command tmux tmux
  install_bridge
  if shell_rc="$(install_alias)"; then
    alias_installed=1
  fi

  say ""
  say "Phone CLI Bridge installed."
  if [[ "$alias_installed" == "1" ]]; then
    say "Run this now to load the alias:"
    say "  source \"$shell_rc\""
    say ""
    say "Then start it from any project directory:"
    say "  $ALIAS_NAME -r"
  else
    say "Alias setup was skipped. Start it with:"
    say "  node \"$INSTALL_DIR/server.mjs\" -w \"\$PWD\" -r"
  fi
}

main "$@"
