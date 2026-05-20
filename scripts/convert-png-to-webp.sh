#!/bin/bash

# Convert PNG images to WebP using cwebp. WebP is preferred for docs images
# because it ships ~25-35% smaller than equivalent PNGs at visually
# indistinguishable quality.
#
# Usage:
#   ./convert-png-to-webp.sh <file.png> [file2.png ...]
#   ./convert-png-to-webp.sh images/configure/*.png
#
# Options:
#   -q QUALITY   cwebp quality (0-100, default 85)
#   -k           Keep the original PNG (default: delete it after successful conversion)
#   -h           Show this help

set -e

QUALITY=85
KEEP_ORIGINAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status()  { echo -e "${BLUE}$1${NC}"; }
print_success() { echo -e "${GREEN}$1${NC}"; }
print_warning() { echo -e "${YELLOW}$1${NC}"; }
print_error()   { echo -e "${RED}$1${NC}"; }

show_usage() {
    head -n 14 "$0" | tail -n 13 | sed 's/^# \{0,1\}//'
}

while getopts ":q:kh" opt; do
    case $opt in
        q) QUALITY=$OPTARG ;;
        k) KEEP_ORIGINAL=1 ;;
        h) show_usage; exit 0 ;;
        \?) print_error "Unknown option: -$OPTARG"; show_usage; exit 1 ;;
        :)  print_error "Option -$OPTARG requires an argument"; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

if [ $# -eq 0 ]; then
    print_error "No input files provided"
    show_usage
    exit 1
fi

if ! command -v cwebp >/dev/null 2>&1; then
    print_error "cwebp not found. Install with: brew install webp"
    exit 1
fi

for input in "$@"; do
    if [ ! -f "$input" ]; then
        print_warning "Skipping (not a file): $input"
        continue
    fi
    if [[ "$input" != *.png && "$input" != *.PNG ]]; then
        print_warning "Skipping (not a .png): $input"
        continue
    fi

    output="${input%.*}.webp"
    print_status "Converting $input → $output (quality=$QUALITY)"

    if ! cwebp -q "$QUALITY" "$input" -o "$output" >/dev/null 2>&1; then
        print_error "Failed to convert: $input"
        exit 1
    fi

    original_size=$(stat -f%z "$input")
    new_size=$(stat -f%z "$output")
    saved=$((original_size - new_size))
    pct=$(( (saved * 100) / original_size ))
    print_success "  ${original_size} → ${new_size} bytes (saved ${saved}, ${pct}%)"

    if [ $KEEP_ORIGINAL -eq 0 ]; then
        rm "$input"
    fi
done

print_success "Done."
