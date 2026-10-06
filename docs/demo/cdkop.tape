# The README recording: synth and apply against an in-memory 1Password
# account. Regenerate from the repository root with vhs 0.12.1 or later,
# since 0.12.0 exits without writing the file
# (https://github.com/charmbracelet/vhs/issues/787):
#
#   vhs docs/demo/cdkop.tape

Output docs/demo/cdkop.gif

Require bun

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 600
Set Padding 24
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Hide
Type `export DEMO="$PWD/docs/demo" && cd "$(mktemp -d)" && ln -s "$DEMO/op-account.ts" . && cdkop() { bun "$DEMO/cdkop.ts" "$@"; } && unset CI && export PS1='$ ' && clear`
Enter
Sleep 1s
Show

Type "cdkop synth op-account.ts"
Sleep 400ms
Enter
Sleep 1.5s

Type "cdkop apply --yes --allow-delete"
Sleep 400ms
Enter
Sleep 4s
Type "y"
Sleep 400ms
Enter
Sleep 5s
