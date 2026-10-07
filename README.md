# Peak Age Packing

Android app for the Peak Age shipping counter (peak-age.com).

## What it does
- **Not Shipped**: orders that have a ShipStation tracking number but no packing photo yet
  (only orders placed on or after the start date in Settings).
- **Packing slip**: every bundle expanded into the individual items to pull, with check-offs.
  Items whose size or quantity isn't defined yet are highlighted.
- **Print all**: prints a slip for every order on the Not Shipped list (Android print service).
- **Photo**: take a photo of the laid-out order. It is uploaded to the store's media library,
  saved on the order (`_pa_pack_photo` order meta), and, if chosen, emailed to the customer
  with the tracking number as a WooCommerce customer note.
- **Shipped** and **Look Up**: find any order by number or customer name and see the photos.

## Where the data lives
- Orders, tracking (ShipStation order notes), photos: the WooCommerce store.
- Bundle contents: Google Sheet "Peak Age Product Contents" (Line Items tab), copied onto
  each product as `_pa_pack_list` product meta by `tools/sync_pack_lists.py`.
  Re-run the sync after editing the sheet.

## First-time setup on the phone
1. Install the APK (allow "Install unknown apps" for the browser or Files app once).
2. Open the app, tap ⚙, and enter: store address, WooCommerce consumer key and secret,
   WordPress username and application password, and the packer's name.
3. Tap **Test connection**, then **Save**.

Credentials are entered on the phone only; they are not in this repository.

## Building
Every push to `main` builds a signed APK in GitHub Actions (artifact "PeakAge-Packing-apk").
The signing key (`app/packing.keystore`) stays the same so new builds install over old ones.
