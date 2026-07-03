#!/bin/sh
set -e

TARGET_DIR=/usr/local/apache2/htdocs/bahmni/ui/app/micro-frontends-dist
mkdir -p "$TARGET_DIR"

escape_js() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g' -e 's/\r/\\r/g'
}

write_config() {
  local varName="$1"
  local varValue="$2"
  if [ -n "$varValue" ]; then
    printf 'window.__MFE_CONFIG__.%s = "%s";\n' "$varName" "$varValue"
  fi
}

{
  echo 'window.__MFE_CONFIG__ = window.__MFE_CONFIG__ || {};' 
  write_config IPS_REGIONAL_BASE "$(escape_js "${IPS_REGIONAL_BASE:-}")"
  write_config IPS_BASIC_USER "$(escape_js "${IPS_BASIC_USER:-}")"
  write_config IPS_BASIC_PASS "$(escape_js "${IPS_BASIC_PASS:-}")"
  write_config IPS_VHL_ISSUANCE_URL "$(escape_js "${IPS_VHL_ISSUANCE_URL:-}")"
  write_config IPS_VHL_RESOLVE_URL "$(escape_js "${IPS_VHL_RESOLVE_URL:-}")"
  write_config ICVP_REGIONAL_BASE "$(escape_js "${ICVP_REGIONAL_BASE:-}")"
  write_config ICVP_BASIC_USER "$(escape_js "${ICVP_BASIC_USER:-}")"
  write_config ICVP_BASIC_PASS "$(escape_js "${ICVP_BASIC_PASS:-}")"
  write_config ICVP_VHL_ISSUANCE_URL "$(escape_js "${ICVP_VHL_ISSUANCE_URL:-}")"
  write_config ICVP_VHL_RESOLVE_URL "$(escape_js "${ICVP_VHL_RESOLVE_URL:-}")"
  write_config ICVP_FROM_BUNDLE_URL "$(escape_js "${ICVP_FROM_BUNDLE_URL:-}")"
  write_config ICVP_BASE "$(escape_js "${ICVP_BASE:-}")"
  write_config MEOW_GENERATE_URL "$(escape_js "${MEOW_GENERATE_URL:-}")"
  write_config MEOW_DECODE_URL "$(escape_js "${MEOW_DECODE_URL:-}")"
  write_config MEOW_BASIC_USER "$(escape_js "${MEOW_BASIC_USER:-}")"
  write_config MEOW_BASIC_PASS "$(escape_js "${MEOW_BASIC_PASS:-}")"
} > "$TARGET_DIR/mfe-runtime-config.js"

exec "$@"
