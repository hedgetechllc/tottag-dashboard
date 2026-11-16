# TotTag Dashboard

Tools for configuring [TotTag](https://lab11.github.io/socitrack/) deployments, and for downloading and
analyzing the data the devices record.

**To use the browser tool, open [app.tottag.net](https://app.tottag.net/).** There is nothing to install.

| Directory | Contents |
| --- | --- |
| [`Web/`](Web/) | The browser tool published at [app.tottag.net](https://app.tottag.net/). It is built on a shared TypeScript package that holds the log-format knowledge. |
| [`Python/`](Python/) | The desktop dashboard (Python/Tkinter), installable with `pip install tottag`, plus analysis helpers. |
| `external/socitrack` | The TotTag firmware ([lab11/socitrack](https://github.com/lab11/socitrack)) as a submodule. The drift and parity checks read it; neither tool needs it to run. |

Both tools write the same `.ttg` log format and speak the same Bluetooth protocol, so a device does not
care which one configured it. Where the two tools must agree on a constant, a parity test checks one
tool's value directly against the other's source.

## Documentation

User documentation for both tools is at [lab11.github.io/socitrack](https://lab11.github.io/socitrack/).
It is built from the [socitrack repository](https://github.com/lab11/socitrack), alongside the firmware
and hardware. Start with [The Dashboard](https://lab11.github.io/socitrack/dashboard.html).

## Working on the tools

```bash
git clone --recursive https://github.com/hedgetechllc/tottag-dashboard
```

`--recursive` fetches the firmware that the checks read. You can leave it out if you only want to
install or run the tools.

- **Browser tool:** `cd Web && npm ci && npm run ci` runs the whole gate. [`Web/README.md`](Web/README.md)
  describes the layout, the commands, and how to check against an unpushed firmware change.
- **Desktop dashboard:** `cd Python && python3 -m pip install -e .`, then run `tottag`.
  [`Python/dashboard/README.md`](Python/dashboard/README.md) lists the modules and the test command.

Every push to `main` runs the browser tool's full gate. If it passes, the build is published to
app.tottag.net through GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). The
desktop dashboard is published to PyPI as `tottag` with `make publish` in `Python/`.

## License

MIT. See [LICENSE](LICENSE).
