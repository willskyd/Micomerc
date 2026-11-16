# Micomerc Windows Thermal Printer Integration

## 1. Project Overview

This project connects the Micomerc POS web application to a Bluetooth thermal receipt printer connected to a Windows 11 computer.

The integration allows Micomerc to print receipts directly from its website using a locally running Windows printer bridge.

### Hardware and software

| Component | Technology |
|---|---|
| POS application | Micomerc |
| Website | https://micomerc.vercel.app |
| Frontend | Next.js, React, TypeScript |
| Deployment | Vercel |
| Operating system | Windows 11 |
| Printer | HPRT MPT-II |
| Printer paper | 58mm thermal paper |
| Printer connection | Bluetooth |
| Local bridge | Node.js |
| Printing method | Windows Print Spooler |
| Printer communication | ESC/POS |

## 2. How the Integration Works

The website does not communicate directly with Bluetooth hardware.

Instead, we created a local Windows printer bridge that receives receipt data from Micomerc and submits it to the Windows Print Spooler.

### Printing architecture

```text
       MICOMERC WEBSITE
    https://micomerc.vercel.app
               |
          HTTPS Request
               |
               v
       CHROME / EDGE BROWSER
               |
      Local network permission
      Apps on device permission
               |
               v
       WINDOWS PRINTER BRIDGE
       127.0.0.1:17891
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
├── start-printer-bridge.ps1
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

**start-printer-bridge.ps1**

This is the Windows startup script created to launch the printer bridge automatically.

It:

- Checks whether the bridge is already running.
- Avoids starting a second copy if the bridge is already healthy.
- Sets the allowed Micomerc website origin.
- Starts the Node.js bridge in the background.
- Checks the health endpoint after startup.
- Reports whether the bridge started successfully.

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

### Start the bridge manually

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

> **FINAL RESULT: SUCCESS**
>
> Micomerc successfully prints receipts from its live website through the Windows 11 computer and the HPRT MPT-II Bluetooth thermal printer.

## 12. Step Ten: Configure Automatic Printer Bridge Startup

Initially, the printer bridge had to be started manually through PowerShell every time it was needed.

To remove this daily manual step, we created a PowerShell startup script and configured Windows Task Scheduler to launch it automatically at user sign-in.

### A. Create the startup script

File location:

```text
C:\Users\LENOVO\micro-mec-printer\start-printer-bridge.ps1
```

The script performs these operations:

1. Sets the error-handling behavior.
2. Defines the bridge folder and Node.js executable.
3. Checks the bridge health endpoint.
4. Avoids launching a duplicate bridge if one is already running.
5. Sets the allowed Micomerc website origin.
6. Starts Node.js in the background.
7. Waits for startup.
8. Checks the bridge health endpoint.
9. Reports whether startup succeeded.

The script was tested using:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\LENOVO\micro-mec-printer\start-printer-bridge.ps1"
```

Successful result:

```text
Micomerc printer bridge is running successfully.
```

### B. Configure Windows Task Scheduler

We opened Task Scheduler:

```text
taskschd.msc
```

Then created a task with the following configuration.

**General tab**

| Setting | Value |
|---|---|
| Task name | Micomerc Printer Bridge |
| Run mode | Run only when user is logged on |
| Highest privileges | Unchecked |

**Triggers tab**

| Setting | Value |
|---|---|
| Begin the task | At log on |
| User | DESKTOP-2ELD3D1\LENOVO |
| Enabled | Yes |

**Actions tab**

| Setting | Value |
|---|---|
| Action | Start a program |
| Program | powershell.exe |

Arguments:

```text
-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\LENOVO\micro-mec-printer\start-printer-bridge.ps1"
```

The task was updated successfully using Administrator PowerShell after an initial access-denied error.

We verified the logon trigger:

```powershell
(Get-ScheduledTask -TaskName "Micomerc Printer Bridge").Triggers |
Format-List *
```

Confirmed trigger account:

```text
UserId : DESKTOP-2ELD3D1\LENOVO
```

The trigger was enabled.

### C. Test the automatic startup

We closed PowerShell, signed out of Windows, and signed back into the LENOVO account.

After signing in, we opened a new PowerShell window and checked the bridge:

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health |
ConvertTo-Json -Depth 5
```

Successful result:

```json
{
  "ok": true,
  "bridgeRunning": true,
  "printerConnected": true,
  "printer": {
    "status": "ready",
    "bluetoothConnected": null,
    "printerDeviceReady": true,
    "writable": true,
    "printerName": "HPRT MPT-II",
    "connection": "windows_print_spooler"
  }
}
```

**Result: Automatic startup was successfully tested after signing out and signing back into Windows.**

The bridge now starts automatically when the configured Windows user signs in.

No daily PowerShell startup command is required.

## 13. How to Use the Printer Every Day

The automatic startup configuration removes the need to manually launch the bridge.

### Daily routine

1. Turn on the Windows computer.
2. Sign in to the LENOVO Windows account.
3. Turn on the HPRT MPT-II printer.
4. Allow Windows to reconnect to the printer.
5. Open Chrome.
6. Visit https://micomerc.vercel.app.
7. Complete a sale or open a saved receipt.
8. Click Print.

The printer bridge should already be running in the background.

### Important operating conditions

- Windows must be running and the configured user must be signed in.
- The computer must not be asleep while printing.
- The printer must be powered on and available to Windows.
- Chrome must retain the required Local network and Apps on device permissions.
- The browser and printer bridge must be on the same Windows computer.

### Manual recovery if automatic startup fails

If the bridge does not start automatically, open PowerShell and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\LENOVO\micro-mec-printer\start-printer-bridge.ps1"
```

Then check its health:

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health |
ConvertTo-Json -Depth 5
```

## 14. Troubleshooting Guide

| Problem | What to check |
|---|---|
| Printer needs attention | Check that the Windows bridge is running |
| Could not reach local printer bridge | Check the bridge and browser permissions |
| Loopback address space blocked | Allow Apps on device in Chrome |
| Local network permission denied | Allow Local network access |
| Printer not connected | Check the Windows printer queue |
| Printer does not print | Check Windows Print Spooler |
| Bridge does not start | Check Node.js installation and port 17891 |
| Website cannot authorize | Check the allowed-origin configuration |
| Receipt formatting is wrong | Check receipt-format.mjs |
| Automatic startup fails | Check Task Scheduler trigger and task history |
| Scheduled task does not run | Verify the configured Windows account and logon trigger |

### Health-check command

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health |
ConvertTo-Json -Depth 5
```

### Check scheduled task status

```powershell
Get-ScheduledTask -TaskName "Micomerc Printer Bridge" |
Format-List TaskName,State,TaskPath
```

### Check the last scheduled task execution

```powershell
Get-ScheduledTaskInfo -TaskName "Micomerc Printer Bridge" |
Format-List LastRunTime,LastTaskResult,NextRunTime
```

A `LastTaskResult` of `0` indicates that the last task execution completed successfully.

## 15. Important Security and Operational Notes

- Keep the bridge bound to `127.0.0.1`, not exposed publicly.
- Keep the allowed-origin list restricted to trusted websites.
- Never publish `printer-token.txt` or authorization secrets.
- Do not expose authorization tokens in screenshots or logs.
- Keep Windows running and signed in while printing.
- Do not assume the printer is Bluetooth-connected simply because its Windows queue reports Ready.
- Do not disable browser security to make printing work.
- Use the existing authorization mechanism rather than bypassing it.
- Do not create duplicate print requests when a receipt is already being submitted.
- The automatic startup task runs at user sign-in; it does not make the bridge run when Windows is shut down or before the configured user signs in.

## 16. Final Architecture Summary

The complete integration consists of four main parts:

**1. Micomerc POS**

Responsible for creating sales, saving transactions, and requesting receipt printing.

**2. Windows Printer Bridge**

Responsible for authorization, receiving receipt data, formatting, and submitting print jobs to Windows.

**3. Windows Task Scheduler**

Responsible for automatically starting the local printer bridge when the configured Windows user signs in.

**4. HPRT MPT-II**

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

Automatic startup path:

```text
Windows Sign-in
      |
      v
Windows Task Scheduler
      |
      v
start-printer-bridge.ps1
      |
      v
Node.js Printer Bridge
      |
      v
127.0.0.1:17891
```

**Integration status: SUCCESSFULLY IMPLEMENTED, TESTED, AND CONFIGURED FOR AUTOMATIC STARTUP.**

Website: https://micomerc.vercel.app

GitHub: https://github.com/willskyd/Micomerc

Printer: HPRT MPT-II (58mm)

Operating system: Windows 11

Printing method: Windows Print Spooler through a local Node.js bridge.

Automatic startup: Windows Task Scheduler at user sign-in.