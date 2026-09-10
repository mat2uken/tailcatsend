# Vendored winit 0.30.13 (patched)

This is the crates.io release of winit 0.30.13 with
[rust-windowing/winit PR #4592](https://github.com/rust-windowing/winit/pull/4592)
("iOS: Implement UITextInput so multi-stage IMEs (CJK pinyin/kana/hangul) work")
applied on top. The PR was written against the `v0.30.x` branch and applies
cleanly to the 0.30.13 release tarball.

## Why

Stock winit 0.30.13 implements only `UIKeyInput` (plus `UITextInputTraits`)
on iOS. Per Apple's docs, that is enough for plain ASCII keypresses, but
multi-stage input methods (Japanese kana / flick, pinyin, hangul, ...) are
excluded unless the view also adopts `UITextInput`. Without it, the iOS soft
keyboard silently drops every keypress, which made text input impossible in
Slint `LineEdit`s on the iOS app.

The patch adopts `UITextInput` on `WinitView`:

- `setMarkedText:selectedRange:` -> `Ime::Preedit`
- `unmarkText` -> commit + clear preedit
- `replaceRange:withText:` -> `Ime::Commit`
- and adds the `UITextInput` feature to the `objc2-ui-kit` dependency.

Slint 1.17.1 pins winit 0.30.13 and upstream has not merged the PR yet, so
the workspace uses `[patch.crates-io] winit = { path = "vendor/winit" }`
(see the root Cargo.toml).

## Updating

When a winit release (or Slint upgrade) includes the upstream fix, delete
this directory and the `[patch.crates-io]` entry.
