# Complete Guide: Connect OpenFit to Google Health

This guide documents the setup used to connect OpenFit to Fitbit data through the Google Health API. It was last updated on June 22, 2026.

## Before You Start

You need:

- the Google account used in the Fitbit mobile app;
- access to [Google Cloud Console](https://console.cloud.google.com/);
- OpenFit running with `npm run dev` or through the desktop app;
- Fitbit Air already paired and synchronized with the Fitbit app on the phone.

The data flow is:

```text
Fitbit Air -> Fitbit mobile app -> Google Health API -> OpenFit
```

OpenFit does not perform the first Bluetooth pairing and does not replace synchronization between the tracker and the phone.

## 1. Create a Google Cloud Project

1. Open [Create Google Cloud project](https://console.cloud.google.com/projectcreate).
2. In **Project name**, enter `OpenFit`.
3. For a personal account, leave **Organization** set to `No organization`.
4. Click **Create**.
5. Wait for creation to finish, then select `OpenFit` from the project selector in the top bar.

From this point on, always verify that **OpenFit** is the selected project. The API, OAuth consent, and OAuth client must belong to the same project.

## 2. Enable the Google Health API

1. With the OpenFit project selected, open [Google Health API](https://console.cloud.google.com/apis/library/health.googleapis.com).
2. Click **Enable**.
3. Wait until **API enabled** appears or the button changes to **Manage**.

If **Manage** already appears, the API is enabled and you can continue.

## 3. Configure Google Auth Platform

1. Open [Google Auth Platform -> Overview](https://console.cloud.google.com/auth/overview).
2. Check again that the selected project is OpenFit.
3. Click **Get started**.
4. In app information, enter:
   - **App name:** `OpenFit`
   - **User support email:** your Google address
5. Choose **External** as the audience.
6. In **Contact information**, enter your email.
7. Accept the user data policy and finish the wizard with **Continue** or **Create**.

### Why External

`Internal` is reserved for users in the same Google Workspace organization. `External` allows a normal personal Google account to authorize the app. During development, the app remains in Testing mode and can only be used by manually added test users.

## 4. Add the Fitbit Account as a Test User

1. Open [Google Auth Platform -> Audience](https://console.cloud.google.com/auth/audience).
2. In **Test users**, click **Add users**.
3. Enter the Google address used in the Fitbit app.
4. Click **Save**.
5. Verify that the address appears in the list.

The account selected in the browser during connection must be the same account listed here.

## 5. Enable Read-Only Scopes

1. Open [Google Auth Platform -> Data Access](https://console.cloud.google.com/auth/scopes).
2. Click **Add or remove scopes**.
3. Search for `Google Health API`.
4. Select the read-only scopes listed below.
5. Click **Update**, then **Save**.

```text
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.ecg.readonly
https://www.googleapis.com/auth/googlehealth.irn.readonly
https://www.googleapis.com/auth/googlehealth.location.readonly
https://www.googleapis.com/auth/googlehealth.nutrition.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
https://www.googleapis.com/auth/googlehealth.settings.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

Do not select write scopes. OpenFit also requests the standard `openid` and `profile` scopes to display the account name and avatar.

## 6. Create the OAuth Client

1. Open [Google Auth Platform -> Clients](https://console.cloud.google.com/auth/clients).
2. Click **Create client**.
3. For application type, choose **Web application**.
4. Use `OpenFit Desktop` as the name.
5. Leave **Authorized JavaScript origins** empty.
6. Under **Authorized redirect URIs**, add exactly:

   ```text
   http://127.0.0.1:42813/oauth/callback
   ```

7. Click **Create**.
8. Store the **Client ID** and **Client Secret** shown by Google.

Do not publish, share, or commit these credentials. Client Secret, tokens, and cache files are stored by OpenFit through the operating system encrypted store.

## 7. Why the Callback Is Local

`127.0.0.1` identifies only the computer where OpenFit is running. It is not a public website and cannot be reached from the internet.

During connection, OpenFit:

1. temporarily opens a local server on port `42813`;
2. opens the system browser for Google consent;
3. receives the OAuth code at `/oauth/callback`;
4. verifies `state` and PKCE to protect the request;
5. closes the local server when the flow completes or after five minutes.

The callback must match the Google Cloud registration character by character, including protocol, IP address, port, and path.

## 8. Connect OpenFit

1. Start OpenFit:

   ```bash
   npm run dev
   ```

2. Click **Connect Fitbit**.
3. Select **Google Health**.
4. Paste the Client ID.
5. Paste the Client Secret.
6. Verify that the Callback URL is:

   ```text
   http://127.0.0.1:42813/oauth/callback
   ```

7. Click **Save and connect**.
8. In the browser, select the Google account added as a test user.
9. Approve the requested access.
10. After confirmation, return to OpenFit. The first sync starts automatically.

## 9. Final Verification

The configuration is working when:

- OpenFit shows `Google Health` instead of `Demo mode`;
- a last synchronization time appears;
- the Devices page shows Fitbit Air or the paired tracker;
- steps, heart rate, or sleep contain real data;
- credentials and cache files in the app data folder are encrypted with `safeStorage`.

Metric availability depends on the device, region, granted consent, and recent Fitbit mobile synchronization.

## Troubleshooting

### The Save and Connect Button Is Disabled

Check that:

- Client ID and Client Secret are both present;
- the callback starts with `http://127.0.0.1:`;
- the operating system secure store is available.

### `redirect_uri_mismatch`

Register exactly this URI in the OAuth client:

```text
http://127.0.0.1:42813/oauth/callback
```

Do not use `localhost`, do not omit `/oauth/callback`, and do not add spaces or a trailing slash.

### `Access blocked`, `access_denied`, or Unauthorized User

- Verify that the audience is **External**.
- Add the correct Google account under **Audience -> Test users**.
- During login, select the same account used in the Fitbit app.

### `invalid_client`

- Copy the Client ID and Client Secret again from the same `OpenFit Desktop` client.
- Make sure no leading or trailing spaces were copied.
- Do not mix credentials from different projects.

### 403 Error or API Not Enabled

Open the Google Health API page and verify that **Manage** appears. The API must be enabled in the same project that contains the OAuth client.

### Port 42813 Is Already in Use

Close other OpenFit windows or processes and try again. Only one OAuth flow can use that port at a time.

### The Browser Authorizes the App but OpenFit Does Not Receive the Callback

- keep OpenFit open during the whole consent flow;
- temporarily disable only local rules that block `127.0.0.1`;
- check that VPNs or proxies are not intercepting loopback addresses;
- try again without changing the callback.

### Some Metrics or Sections Are Missing

1. Open the Fitbit app on the phone.
2. Wait for Fitbit Air to synchronize.
3. Return to OpenFit and click **Sync**.
4. Check effective source coverage on the **Data** page.

ECG, SpO2, temperature, HRV, and irregular rhythm notifications may not be available for every device, account, or country. OpenFit automatically hides sections without data.

### The Connection Stops Working After Seven Days

In Google OAuth `Testing` mode, refresh tokens normally expire after seven days. You can reconnect the account or complete Google's requirements to move the app to production.

## Quick Checklist

- [ ] `OpenFit` project created and selected
- [ ] Google Health API enabled
- [ ] Google Auth Platform configured
- [ ] Audience set to `External`
- [ ] Fitbit account added as a test user
- [ ] Google Health `.readonly` scopes added
- [ ] `OpenFit Desktop` client created as a web application
- [ ] Local callback registered exactly
- [ ] Client ID and Client Secret entered in OpenFit
- [ ] Consent completed with the correct account
- [ ] First sync completed

## Official References

- [Google Health API: Cloud and OAuth setup](https://developers.google.com/health/setup)
- [Google Health API: scopes](https://developers.google.com/health/scopes)
- [Google Health API: data types](https://developers.google.com/health/data-types)
- [Google OAuth for web applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth for desktop applications](https://developers.google.com/identity/protocols/oauth2/native-app)
