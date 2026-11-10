# Upload buffer permissions

An HTTP 500 with no upstream status and an Nginx error opening a client-body
temporary file means the upload failed before reaching the application.
Small text requests can still work because larger bodies spill to disk.

The generic Nginx template uses a dedicated client-body directory. Provision it
for the **effective Nginx worker user**, not the web application or tenant UID.
For a host whose workers run as `www-data`:

```sh
sudo install -d -o root -g root -m 0755 /var/lib/codex-web-nginx
sudo install -d -o www-data -g www-data -m 0700 /var/lib/codex-web-nginx/client-body
sudo sh scripts/check-nginx-upload-buffer.sh www-data /var/lib/codex-web-nginx/client-body
sudo nginx -t
sudo systemctl reload nginx
```

Use the configured worker identity on other distributions. For containers,
provision and check within the same filesystem and user namespace as Nginx.
Keep a private backup of the existing site configuration before applying changes.
Subpath deployments must preserve their existing locations and proxy headers;
add only the dedicated `client_body_temp_path` at the relevant server/location.
Do not share this directory with another Nginx instance or tenant workspace.
Do not recursively change ownership of application data or use mode 0777.

After deployment, send synthetic multipart bodies larger than the configured
client-body buffer (for example 75 KB, 110 KB and 1 MiB). An unauthenticated
request should reach the application and return its expected authentication
error, not a proxy 500. This proves transport only: also paste a screenshot
while logged in and check that the attachment preview appears. Nginx can unlink
temporary files while retaining open descriptors; an empty directory during an
upload is not proof that buffering was bypassed.

Run the directory write check and upload probe after Nginx configuration or
deployment updates. This configuration fix does not require an application
restart, data migration, changes to upload size limits, or relaxed authentication.
