#!/usr/bin/env bash
set -uo pipefail

status=0
help_output_file="$(mktemp)"

cleanup() {
  rm -f "$help_output_file"
}

pass() {
  printf 'PASS: %s\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  status=1
}

section() {
  printf '\n== %s ==\n' "$1"
}

trap cleanup EXIT

section "Environment"
printf 'CUDA_VISIBLE_DEVICES=%s\n' "${CUDA_VISIBLE_DEVICES:-<unset>}"

llama_server_bin="${LLAMACPP_SERVER_BIN:-}"
if [[ -z "$llama_server_bin" ]]; then
  fail "LLAMACPP_SERVER_BIN is required: set it to the llama-server binary path"
  exit "$status"
fi
llama_server_dir="$(dirname "$llama_server_bin")"
export LD_LIBRARY_PATH="$llama_server_dir:/usr/local/cuda/targets/x86_64-linux/lib:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}"

if [[ ! -x "$llama_server_bin" ]]; then
  fail "llama-server binary not found or not executable: $llama_server_bin"
  exit "$status"
fi

pass "llama-server found at $llama_server_bin"

section "Process Check"
running_processes="$(pgrep -af '(^|/)llama-server( |$)' || true)"
if [[ -n "$running_processes" ]]; then
  fail "llama-server is already running"
  printf '%s\n' "$running_processes"
else
  pass "no running llama-server"
fi

section "Version"
if version_output="$("$llama_server_bin" --version 2>&1)"; then
  pass "llama-server --version"
  printf '%s\n' "$version_output"
else
  fail "llama-server --version failed"
fi

section "Flag Support"
if "$llama_server_bin" --help >"$help_output_file" 2>&1; then
  pass "llama-server --help"
else
  fail "llama-server --help failed"
fi

for flag in --fit --n-gpu-layers --ctx-size --parallel --batch-size --ubatch-size; do
  if grep -Fq -- "$flag" "$help_output_file"; then
    pass "supports $flag"
  else
    fail "missing $flag"
  fi
done

section "CUDA Devices"
if devices_output="$("$llama_server_bin" --list-devices 2>&1)"; then
  pass "llama-server --list-devices"
  printf '%s\n' "$devices_output"
else
  fail "llama-server --list-devices failed"
fi

section "GPU State"
if command -v nvidia-smi >/dev/null 2>&1; then
  if gpu_summary="$(nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu --format=csv,noheader 2>&1)"; then
    pass "nvidia-smi GPU summary"
    printf '%s\n' "$gpu_summary"
  else
    fail "nvidia-smi GPU summary failed"
  fi

  if compute_processes="$(nvidia-smi --query-compute-apps=pid,process_name,gpu_uuid,used_gpu_memory --format=csv,noheader,nounits 2>&1)"; then
    pass "nvidia-smi compute process query"
    if [[ -n "$compute_processes" ]]; then
      printf '%s\n' "$compute_processes"
    else
      printf '(no running GPU compute processes)\n'
    fi
  else
    fail "nvidia-smi compute process query failed"
  fi
else
  fail "nvidia-smi not found in PATH"
fi

section "Result"
if [[ "$status" -eq 0 ]]; then
  pass "diagnostics completed without starting llama-server"
else
  warn "diagnostics found one or more issues"
fi

exit "$status"
