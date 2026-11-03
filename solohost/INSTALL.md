# Install on SoloHost

1. Open SoloHost in Pi Desktop.
2. Create/add an app using the two files in this folder:
   - docker-compose.yml
   - config_options.yml
3. Save the configuration and start the app.
4. Open the app and create the owner account (first run). Set `HUB_SETUP_TOKEN` first if the Hub is reachable from the Internet.
5. To connect with other Hubs set `HUB_PUBLIC_URL` (HTTPS address that reaches this Hub) and add peers in the **Network** screen.
6. If SoloHost reports an image or configuration error, return to App Builder and paste the error.

The Builder keeps the previous project context so it can continue troubleshooting without asking you to repeat the whole process.
