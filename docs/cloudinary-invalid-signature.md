# Cloudinary "Invalid Signature" — Fix Checklist

When admin media upload returns `CLOUDINARY_ERROR` with message like:

```
Invalid Signature ... String to sign - 'folder=...&overwrite=0&public_id=...&timestamp=...&transformation=...&unique_filename=1'
```

the server’s `CLOUDINARY_API_SECRET` does not match the API Secret in your Cloudinary account. Follow these steps to fix it.

---

## Step 1: Get the correct API Secret from Cloudinary

1. Log in to [Cloudinary Console](https://console.cloudinary.com/).
2. Go to **Settings** (gear icon) → **API Keys**.
3. Copy the **API Secret** (the long string). Do **not** use Cloud Name or API Key.
4. Confirm you’re in the account that matches your `CLOUDINARY_CLOUD_NAME`.

---

## Step 2: Update Render environment variable

1. Open the [Render Dashboard](https://dashboard.render.com/).
2. Select the service (e.g. **barber-bang**).
3. Open the **Environment** tab.
4. Find `CLOUDINARY_API_SECRET` and set it to the value from Step 1.
5. Click **Save Changes** (Render will redeploy with the new secret).

---

## Verification checklist

Ensure these match between Render and the Cloudinary Dashboard:

| Env var | Description |
|--------|-------------|
| `CLOUDINARY_CLOUD_NAME` | Your cloud name |
| `CLOUDINARY_API_KEY` | Numeric API key |
| `CLOUDINARY_API_SECRET` | API secret string (this is usually the one that was wrong) |

---

## Common causes

- Copy/paste mistake when setting the env var.
- API Secret was regenerated in Cloudinary and not updated on Render.
- Credentials from a different Cloudinary account.
- Leading/trailing spaces or newlines in `CLOUDINARY_API_SECRET`.

---

See also: [Runbook §7 — Admin media upload: Cloudinary "Invalid Signature"](runbook.md).
