# coesite5

PMTiles vector tile server (onyx with Azure AD authentication) in the development environment.  
Please be advised that this repository is for a specific environment. Not for general use.

Compared with un-vector-tile-toolkit/coesite, this repository has following characters:

1. npm modules are updated.
2. ESRI interface has been added. (see unvt/marble to check how it works)
3. mysql is used for the session store.
4. Some functions, such as raster drawing test and story-telling, are removed to make the structure simple.

## environment

I developed this nodejs server for Red Hat Enterprise Linux release 9.5.  
Nodejs v22.14.0

npm 10.9.2

pm2 v6.0.5

## install

```console
git clone https://github.com/unvt/coesite5
cd coesite5
npm install
```

## Run

### Config setting

Edit .env and config/default.hjson to provide necessary confit setting, and prepare mysql to store the session info.

```
OAUTH_CLIENT_ID=Your APP/Client ID
OAUTH_CLIENT_SECRET=Your secret
OAUTH_REDIRECT_URI=https://yourdomain/unvt/auth/callback
OAUTH_SCOPES='user.read'
OAUTH_AUTHORITY=https://login.microsoftonline.com/(your place)/
```

### Start server

node app.js  
 or  
./pmserve.sh

To stop, run ./pmstop.sh  
(Please make sure that you have the permission to execute sh scripts.)

sh containts sudo because I needed it in my own environment.

## Structure

top page will be https://(your domain)/unvt  
Tile will be served from https://(your domain)/unvt/VT/zxy/{t}/{z}/{x}/{y}.pbf

## Tips

If your node is not allow to use port 443, try

```console
which node
sudo setcap cap_net_bind_service=+ep (your location)/bin/node
```

### Plugins

Some plugins are stored in the public folder.
maplibre-gl-export and maplibr-gl-legend are from watergis. (MIT license)

## Reference

https://docs.microsoft.com/en-us/graph/tutorials/node?WT.mc_id=Portal-Microsoft_AAD_RegisteredApps&tutorial-step=3
