/* =====================================================================
   config.js — EDIT THIS FILE to change the start position, base maps or
   place search. No server is needed: the whole app runs in the browser.

   Base maps that need an API key ("keySetting") are switched on when a
   user enters their own key under Settings; the key is stored only in
   that user's browser. Never write a real key into this file if the site
   is public.
   ===================================================================== */
"use strict";
window.SM = window.SM || {};
window.SM.APP_CONFIG = {
  version: "1.4.0-web",

  // where the map opens for a brand-new user (Patna)
  defaultView: { center: [25.5941, 85.1376], zoom: 12 },
  defaultBasemap: "esri_imagery",

  // place-name search: OpenStreetMap Nominatim (free, light use, max 1 request/second)
  geocoder: true,
  geocoderUrl: "https://nominatim.openstreetmap.org/search",

  // largest file accepted by Import (MB)
  maxUploadMb: 25,

  providers: [
    {
      "id": "esri_imagery",
      "name": "Satellite (Esri World Imagery)",
      "kind": "satellite",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          "maxNativeZoom": 19,
          "maxZoom": 22
        }
      ]
    },
    {
      "id": "esri_imagery_labels",
      "name": "Satellite + place labels",
      "kind": "satellite",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Imagery &copy; Esri, Maxar, Earthstar Geographics",
          "maxNativeZoom": 19,
          "maxZoom": 22
        },
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Labels &copy; Esri",
          "maxNativeZoom": 19,
          "maxZoom": 22,
          "overlay": true
        }
      ]
    },
    {
      "id": "esri_hybrid",
      "name": "Hybrid (satellite + roads + labels)",
      "kind": "satellite",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Imagery &copy; Esri, Maxar, Earthstar Geographics",
          "maxNativeZoom": 19,
          "maxZoom": 22
        },
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Roads &copy; Esri",
          "maxNativeZoom": 19,
          "maxZoom": 22,
          "overlay": true
        },
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Labels &copy; Esri",
          "maxNativeZoom": 19,
          "maxZoom": 22,
          "overlay": true
        }
      ]
    },
    {
      "id": "osm",
      "name": "Street map (OpenStreetMap)",
      "kind": "street",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          "attribution": "&copy; OpenStreetMap contributors",
          "maxNativeZoom": 19,
          "maxZoom": 22
        }
      ]
    },
    {
      "id": "esri_topo",
      "name": "Topographic (Esri World Topo)",
      "kind": "terrain",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
          "attribution": "Tiles &copy; Esri, HERE, Garmin, USGS, NGA, EPA, NPS",
          "maxNativeZoom": 19,
          "maxZoom": 22
        }
      ]
    },
    {
      "id": "opentopomap",
      "name": "Terrain (OpenTopoMap)",
      "kind": "terrain",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
          "subdomains": "abc",
          "attribution": "&copy; OpenStreetMap contributors, SRTM | Style &copy; OpenTopoMap (CC-BY-SA)",
          "maxNativeZoom": 17,
          "maxZoom": 20
        }
      ]
    },
    {
      "id": "maptiler_satellite",
      "name": "Satellite (MapTiler, API key)",
      "kind": "satellite",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key={key}",
          "attribution": "&copy; MapTiler &copy; OpenStreetMap contributors",
          "maxNativeZoom": 20,
          "maxZoom": 22
        }
      ],
      "keySetting": "maptiler"
    },
    {
      "id": "mapbox_satellite",
      "name": "Satellite (Mapbox, access token)",
      "kind": "satellite",
      "print_allowed": true,
      "layers": [
        {
          "url": "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/{z}/{x}/{y}?access_token={key}",
          "attribution": "&copy; Mapbox &copy; Maxar &copy; OpenStreetMap contributors",
          "maxNativeZoom": 21,
          "maxZoom": 22
        }
      ],
      "keySetting": "mapbox"
    }
  ],
};
