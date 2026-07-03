#!/usr/bin/env bash
# exit on error
set -o errexit

npm install

# Puppeteer-এর জন্য ব্রাউজার ক্যাশ ডিরেক্টরি সেট করা এবং ক্রোম ইনস্টল করা
STORE_DIR=/opt/render/project/.render

if [ ! -d "$STORE_DIR" ]; then
  echo "...Creating Render store directory"
  mkdir -p $STORE_DIR
fi

echo "...Installing Chrome for Puppeteer"
npx puppeteer browsers install chrome