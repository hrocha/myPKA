# Self-hosted PMTiles basemap (demo extract)

`germany-z14.pmtiles` here is a SMALL demo extract (~4.9 MB) covering only the
Außenalster area of Hamburg — the union bbox of the 8 synthetic demo GPX
workouts in `PKM/Documents/_files/gpx/` plus a ~3 km margin. It is NOT the full
Germany extract the filename suggests; the name is kept because the client
(`web/src/components/WorkoutMap.tsx`) and the `/api/cockpit/basemap-status`
probe (`server/wellness.js`) hardcode `basemap/germany-z14.pmtiles`.

The file is gitignored (`*.pmtiles`) — regenerate it locally when missing:

```sh
# brew install pmtiles  (or download a go-pmtiles release binary)
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  web/public/basemap/germany-z14.pmtiles \
  --bbox=9.94846,53.53025,10.05691,53.60655 --maxzoom=14
# pick the latest daily build, e.g. 20260612 (probe with:
#   curl -sI https://build.protomaps.com/YYYYMMDD.pmtiles)

# the built SPA serves from web/dist — copy the file there too:
mkdir -p web/dist/basemap
cp web/public/basemap/germany-z14.pmtiles web/dist/basemap/
```

For a wider-area basemap, enlarge `--bbox` (lower `--maxzoom` to 13 if the
result grows much past ~80 MB). If the file is absent the cockpit degrades
gracefully: routes/heat render on a neutral background, no cloud tiles ever.

Attribution: © OpenStreetMap contributors (basemap data via Protomaps daily
builds, ODbL).
