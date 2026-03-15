# Church Health Dashboard — Planning Center

A local dashboard for tracking volunteer health and attendance from Planning Center.

## Setup (2 minutes)

### Requirements
- [Node.js](https://nodejs.org/) (v14 or newer — most Macs/PCs already have it)

### Run it

1. Unzip this folder somewhere on your computer
2. Open Terminal (Mac) or Command Prompt (Windows)
3. Navigate to the folder:
   ```
   cd pco-dashboard
   ```
4. Start the server:
   ```
   node server.js
   ```
5. Open your browser to: **http://localhost:3000**

### Connect Planning Center

1. Go to https://api.planningcenteronline.com/oauth/applications
2. Scroll to **Personal Access Tokens** → click **Create one now**
3. Give it a name (e.g. "Health Dashboard") and copy the **Application ID** and **Secret**
4. Paste both into the dashboard's connect modal

Your credentials are stored only in memory and are never written to disk.

## Stopping the server
Press `Ctrl+C` in the terminal window.

## Tabs
- **Overview** — at-a-glance stats + 8-week attendance & volunteer charts
- **Volunteers** — show-up rate, declines, blockouts, first-timers, multi-service volunteers
- **Attendance** — weekly breakdown table + trend chart
- **Teams** — per-team coverage cards with color-coded health indicators
