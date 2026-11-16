# Micomerc Windows Thermal Printer Integration

## 1. Project Overview

This project connects the Micomerc POS web application to a Bluetooth thermal receipt printer connected to a Windows 11 computer.

The integration allows Micomerc to print receipts directly from its website using a locally running Windows printer bridge.

### Hardware and software

| Component             | Technology                                                 |
| --------------------- | ---------------------------------------------------------- |
| POS application       | Micomerc                                                   |
| Website               | [https://micomerc.vercel.app](https://micomerc.vercel.app) |
| Frontend              | Next.js, React, TypeScript                                 |
| Deployment            | Vercel                                                     |
| Operating system      | Windows 11                                                 |
| Printer               | HPRT MPT-II                                                |
| Printer paper         | 58mm thermal paper                                         |
| Printer connection    | Bluetooth                                                  |
| Local bridge          | Node.js                                                    |
| Printing method       | Windows Print Spooler                                      |
| Printer communication | ESC/POS                                                    |

## 2. How the Integration Works

The website does not communicate directly with Bluetooth hardware.

Instead, we created a local Windows printer bridge that receives receipt data from Micomerc and submits it to the Windows Print Spooler.

### Printing architecture

```text
       MICOMERC WEBSITE
    https://micomerc.vercel.app
               |
               |
          HTTPS Request
               |
               v
       CHROME / EDGE BROWSER
               |
               |
      Local network permission
      Apps on device permission
               |
               v
       WINDOWS PRINTER BRIDGE
       127.0.0.1:17891
               |
               |
          Node.js Server
               |
               v
       RECEIPT FORMATTER
          ESC/POS bytes
               |
               v
       WINDOWS PRINT SPOOLER
               |
               |
          Bluetooth
               |
               v
          HPRT MPT-II
               |
               v
         PRINTED RECEIPT
```

The Windows computer must be running the bridge because `127.0.0.1` refers to the computer on which the browser is running.

## 3. Step One: Configure the Windows Printer

The physical printer was connected to the Windows 11 computer through Bluetooth.

Printer details:

- Printer name: HPRT MPT-II
- Bluetooth device: MPT-II_30AE
- Printer driver: HPRT MPT-II
- Windows printer queue: HPRT MPT-II
- Associated Bluetooth serial port: COM3
- Printer width: 58mm

We confirmed that:

- Windows detected the printer.
- The printer driver was installed.
- The printer appeared in Windows Printers.
- The Windows Print Spooler was running.

### Important discovery

Direct serial communication through COM3 was unsuccessful.

Instead of continuing with direct serial printing, we switched to the Windows Print Spooler.

This was important because Windows had already established the printer connection and could manage print jobs through its installed printer driver.

## 4. Step Two: Install Node.js on Windows

Node.js was installed on the Windows computer.

Versions used during setup:

```text
Node.js: v26.13.1
npm: 11.20.0
```

We verified the installation using PowerShell:

```powershell
node --version
npm.cmd --version
```

We used `npm.cmd` because PowerShell's execution policy blocked the normal npm PowerShell script.

## 5. Step Three: Create the Windows Printer Bridge

The bridge project was created inside:

```text
C:\Users\LENOVO\micro-mec-printer
```

The important files were:

```text
micro-mec-printer/
│
├── printer-bridge.mjs
├── printer-discovery.mjs
├── receipt-format.mjs
├── printer-spooler.ps1
├── printer-token.txt
│
├── package.json
└── node_modules/
```

### Purpose of each file

**printer-bridge.mjs**

This is the main local HTTP server.

It:

- Listens on `127.0.0.1:17891`.
- Accepts requests from the Micomerc website.
- Checks allowed website origins.
- Handles browser CORS requests.
- Provides printer authorization.
- Receives receipt information.
- Prevents duplicate and simultaneous print submissions.
- Sends formatted receipts to the Windows printing system.

**printer-discovery.mjs**

This handles printer detection and status reporting.

It checks the Windows printer queue and reports whether the printer is available and ready.

**receipt-format.mjs**

This converts Micomerc sale information into ESC/POS receipt data.

It handles:

- Micomerc branding.
- Receipt number.
- Product names.
- Quantities.
- Unit prices.
- Subtotals.
- Discounts.
- Taxes.
- Total amount.
- Payment information.
- Amount tendered.
- Change.

The receipt formatter was configured for the 58mm printer.

**printer-spooler.ps1**

This is the Windows printing component.

It uses Windows Print Spooler APIs to submit the formatted receipt bytes as a RAW print job.

This allows the printer to receive ESC/POS commands through the Windows printer queue.

## 6. Step Four: Configure Printer Authorization

The local bridge was protected so that arbitrary websites could not freely submit print jobs.

We implemented:

- An allowed-origin list.
- HMAC-SHA256 authorization.
- Random authorization nonces.
- Short-lived authorization grants.
- One-use authorization.
- Duplicate print protection.

The bridge only accepts requests from approved origins.

For Micomerc, the allowed origin is:

```text
https://micomerc.vercel.app
```

We configured it in Windows PowerShell:

```powershell
$env:MICRO_MEC_ALLOWED_ORIGINS = "https://micomerc.vercel.app"
```

The authorization endpoint is:

```text
http://127.0.0.1:17891/authorize
```

The receipt endpoint is:

```text
http://127.0.0.1:17891/print-receipt
```

The test printing endpoint is:

```text
http://127.0.0.1:17891/print-test
```

The health endpoint is:

```text
http://127.0.0.1:17891/health
```

## 7. Step Five: Test the Windows Printer Bridge

Before connecting the website, we tested the bridge independently.

### Start the bridge

Open PowerShell:

```powershell
cd C:\Users\LENOVO\micro-mec-printer

$env:MICRO_MEC_ALLOWED_ORIGINS = "https://micomerc.vercel.app"

node .\printer-bridge.mjs
```

Successful startup message:

```text
Micomerc Windows printer bridge listening at http://127.0.0.1:17891
```

### Check printer health

Open another PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health |
ConvertTo-Json -Depth 5
```

Expected result:

```json
{
  "ok": true,
  "bridgeRunning": true,
  "printerConnected": true,
  "printer": {
    "status": "ready",
    "printerDeviceReady": true,
    "writable": true,
    "printerName": "HPRT MPT-II",
    "connection": "windows_print_spooler"
  }
}
```

We also tested the `/authorize` and `/print-test` endpoints using PowerShell.

**Result:** The printer physically printed the test receipt.

This confirmed that the Windows bridge and physical printer were communicating successfully.

## 8. Step Six: Connect the Micomerc Website

The Micomerc project was maintained on Ubuntu.

Project directory:

```bash
cd ~/User/Micomerc
```

The main integration was implemented inside:

```text
components/dashboard/PosCart.tsx
```

The `printSale` function was responsible for sending saved sale information to the local Windows bridge.

### Printing process

1. A sale is completed and saved.
2. Micomerc passes the saved sale information to `printSale`.
3. The application requests authorization from the local bridge.
4. The bridge returns a temporary authorization grant.
5. Micomerc submits the sale data to `/print-receipt`.
6. The bridge validates the request.
7. The receipt formatter creates ESC/POS data.
8. The PowerShell spooler component submits the print job.
9. Windows sends the job to the HPRT MPT-II.

The integration also includes:

- Printing status messages.
- Retry handling.
- Duplicate request protection.
- Error handling.
- Existing browser/PDF fallback.

A failed printing attempt does not undo a saved sale.

## 9. Step Seven: Build and Deploy Micomerc

After modifying the application, we checked the production build.

From Ubuntu:

```bash
cd ~/User/Micomerc

pnpm build
```

The build completed successfully.

We then staged the required files:

```bash
git add app/globals.css \
  components/dashboard/PosCart.tsx \
  next-env.d.ts \
  package.json \
  pnpm-lock.yaml
```

We checked the staged changes:

```bash
git diff --cached --stat
git diff --cached --check
```

Then committed:

```bash
git commit -m "Connect Micomerc receipts to Windows thermal printer"
```

Commit:

```text
cbb87d7
```

We pushed the changes to GitHub:

```bash
git push origin Wills
```

GitHub repository:

```text
https://github.com/willskyd/Micomerc.git
```

Vercel deployed the updated application successfully.

Deployment status:

```text
Ready
```

## 10. Step Eight: Configure Chrome Permissions

This was the most important troubleshooting discovery.

Initially, the printer bridge was healthy, but Micomerc could not print.

The browser console showed:

```text
Access to fetch at
'http://127.0.0.1:17891/authorize'
from origin
'https://micomerc.vercel.app'
has been blocked by CORS policy:

Permission was denied for this request
to access the loopback address space.
```

The problem was not the printer, Node.js, or Vercel.

Chrome was blocking the website from accessing the local Windows loopback address.

### The solution

We opened:

```text
https://micomerc.vercel.app
```

Then:

1. Clicked the site controls icon beside the address bar.
2. Opened Site settings.
3. Located **Local network** and set it to Allow.
4. Located **Apps on device** and set it to Allow.
5. Returned to Micomerc.
6. Reloaded the website.

**Important:** Local network access and Apps on device are separate permissions in supported Chrome versions.

The Apps on device permission was the missing permission that resolved the loopback access problem.

No additional Vercel deployment was required for this browser permission change.

## 11. Step Nine: Final Website Printing Test

After configuring Chrome:

1. Started the Windows printer bridge.
2. Opened Micomerc in Chrome on the same Windows computer.
3. Signed in.
4. Opened saved sales.
5. Selected an existing receipt.
6. Clicked Print.

The receipt successfully printed physically through the HPRT MPT-II.

\<blockquote> \*\*FINAL RESULT: SUCCESS\*\*

Micomerc now prints receipts from its live website through the Windows 11 computer and the HPRT MPT-II Bluetooth thermal printer.

\</blockquote>

## 12. How to Use the Printer Every Day

Whenever you want to print Micomerc receipts:

### On Windows

Open PowerShell:

```powershell
cd C:\Users\LENOVO\micro-mec-printer

$env:MICRO_MEC_ALLOWED_ORIGINS = "https://micomerc.vercel.app"

node .\printer-bridge.mjs
```

Keep this PowerShell window open.

### In Chrome

1. Open [https://micomerc.vercel.app](https://micomerc.vercel.app).
2. Sign in.
3. Complete a sale or open an existing saved receipt.
4. Click Print.

The receipt should go to the HPRT MPT-II.

## 13. Troubleshooting Guide

| Problem                              | What to check                             |
| ------------------------------------ | ----------------------------------------- |
| Printer needs attention              | Check that the Windows bridge is running  |
| Could not reach local printer bridge | Check the bridge and browser permissions  |
| Loopback address space blocked       | Allow Apps on device in Chrome            |
| Local network permission denied      | Allow Local network access                |
| Printer not connected                | Check the Windows printer queue           |
| Printer does not print               | Check Windows Print Spooler               |
| Bridge does not start                | Check Node.js installation and port 17891 |
| Website cannot authorize             | Check the allowed-origin configuration    |
| Receipt formatting is wrong          | Check receipt-format.mjs                  |

### Health-check command

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health |
ConvertTo-Json -Depth 5
```

## 14. Important Security and Operational Notes

- Keep the bridge bound to `127.0.0.1`, not exposed publicly.
- Keep the allowed-origin list restricted to trusted websites.
- Never publish `printer-token.txt` or authorization secrets.
- Do not expose authorization tokens in screenshots or logs.
- Keep the Windows bridge running while printing.
- Do not assume the printer is Bluetooth-connected simply because its Windows queue reports Ready.
- Do not disable browser security to make printing work.
- Use the existing authorization mechanism rather than bypassing it.
- Do not create duplicate print requests when a receipt is already being submitted.

## 15. Final Architecture Summary

The complete integration consists of three main systems:

**1. Micomerc POS**

Responsible for creating sales, saving transactions, and requesting receipt printing.

**2. Windows Printer Bridge**

Responsible for authorization, receiving receipt data, formatting, and submitting print jobs to Windows.

**3. HPRT MPT-II**

Responsible for physically printing the thermal receipt.

The final communication path is:

```text
Micomerc
   |
   v
Chrome / Edge
   |
   v
127.0.0.1:17891
   |
   v
Node.js Printer Bridge
   |
   v
ESC/POS Receipt Formatter
   |
   v
Windows Print Spooler
   |
   v
Bluetooth
   |
   v
HPRT MPT-II
```

**Integration status: SUCCESSFULLY IMPLEMENTED AND TESTED.**

Website: [https://micomerc.vercel.app](https://micomerc.vercel.app)

Printer: HPRT MPT-II (58mm)

Operating system: Windows 11

Printing method: Windows Print Spooler through a local Node.js bridge.
