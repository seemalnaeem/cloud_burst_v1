// Runtime configuration escape hatch.
//
// Leave apiBase blank and the client derives it from window.location.hostname
// at page load, which is the normal case and the reason a new DHCP address
// needs no rebuild.
//
// Set apiBase only when the gateway lives somewhere other than the host that
// served this page, for example a fixed deployment behind a domain name.
//
//   window.__CBD_CONFIG__ = { apiBase: 'https://cari.example.org' }
//
// mapboxToken is read here first, then from VITE_MAPBOX_TOKEN. Setting it here
// means a deployment can change its token by editing one file in the served
// directory, with no rebuild. Leave it blank for the normal case and put the
// token in .env instead.
//
// Note this file is public: anything in it is visible to anyone who loads the
// portal. That is fine for a Mapbox token, which is a public client token and
// should be restricted by URL in the Mapbox account. Never put a secret here.

window.__CBD_CONFIG__ = {
  apiBase: '',
  gatewayPort: '3090',
  mapboxToken: ''
}
