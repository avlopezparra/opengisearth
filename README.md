<p align="center"><img src="assets/banner.png" alt="OpenGISEarth — open-source 3D globe and GIS editor" width="100%"></p>

# OpenGISEarth

Open-source 3D globe and GIS editor, designed as an alternative to the Google Earth Pro desktop app.

**Use it in the browser:** https://opengisearth.com · **Play OpenStarshipEarth:** https://opengisearth.com/starship/ · **Windows app:** [Releases](https://github.com/avlopezparra/opengisearth/releases/latest)

- Globe with 3D terrain, open base maps, clouds, international borders, disputed boundaries, regional boundaries, streets, parks and 3D buildings.
- Country, province/region and historical-country layers, each with optional area coloring; historical maps by year.
- Placemarks, paths, polygons and image overlays; editing with snapping and topology.
- Opens and saves KML, KMZ, GeoJSON, Shapefile, GeoPackage, SVG, GPX and CSV.
- More than 100 geoprocessing tools equivalent to those in QGIS and ArcGIS: see [TOOLS.md](TOOLS.md).
- Watersheds by clicking a point, mountain ranges, graticule.
- Print layout (PDF, PNG, SVG) and flight simulator.
- Live satellites, country cards with Wikidata and World Bank data, points of view for disputed territories.
<p align="center"><img src="assets/starship-banner.png" alt="OpenStarshipEarth" width="100%"></p>

- OpenStarshipEarth: an arcade flight game over the real Earth (adventure, city races, bosses, local and online multiplayer).
- Interface in Spanish and English.
- MCP server in the Windows app: an AI assistant (Claude Code, Gemini CLI, Codex CLI, OpenCode…) can move the map, switch layers, draw GeoJSON and run the geoprocessing tools. See [AI assistants (MCP)](#ai-assistants-mcp).

The web app lives in `web/`; `src-tauri/` packages it as a Windows program (Tauri). Design notes: [DESIGN.md](DESIGN.md).

Created by Alejandro Víctor López Parra ([avlopezparra](https://github.com/avlopezparra)). Donations: [PayPal](https://paypal.me/alopcl).

## AI assistants (MCP)

The Windows app can serve the [Model Context Protocol](https://modelcontextprotocol.io) so that an AI assistant works the atlas for you.

1. In the app, press **MCP (IA)**, tick *Servidor MCP encendido* and apply. The dialog shows the address, the token and a ready configuration.
2. Give them to your assistant. For Claude Code:
   `claude mcp add --transport http opengisearth http://127.0.0.1:47778/mcp --header "Authorization: Bearer <token>"`
3. Ask in the chat: *"fly to Valparaíso and draw a 2 km buffer around the port"*.

The server listens on this computer only (127.0.0.1), every request must carry the token, and the assistant can only call the listed tools: `get_view`, `fly_to`, `search_place`, `list_layers`, `set_layer`, `list_groups`, `get_features`, `add_features`, `list_tools`, `run_tool`, `remove_group` and `screenshot`. Deleting a group it did not create asks you first. To start it from a script, set `OGE_MCP_TOKEN` (16 to 64 letters or digits) and optionally `OGE_MCP_PORT` before launching the app.

## License

Copyright (c) 2026 Alejandro Víctor López Parra. OpenGISEarth is free software under the [GNU Affero General Public License, version 3](LICENSE): anyone may use, study, share and change it, and whoever distributes it or offers a changed version over a network must publish that version's source under the same license. Versions published before this notice were under the MIT license and remain so.

