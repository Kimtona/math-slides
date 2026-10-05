#!/bin/zsh
# Double-click in Finder to launch MathSlides as a desktop app.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"
[ -d node_modules ] || npm install
npm run app
