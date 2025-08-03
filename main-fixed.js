document.addEventListener('DOMContentLoaded', () => {
  // --- CONFIGURATION --- [Updated]
  const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbxs1YtXnWaN8ojAwiw33wQ0xEzfSrtXPHli1uWkoFZjC4KVIvcd1F0jEvg0KuM13YV_gQ/exec';
  const DB_NAME = 'AttendanceDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'offlineQueue';
  const SCAN_DEBOUNCE_DELAY = 300; // ms delay to prevent accidental double scans

  // --- DOM ELEMENTS ---
  const setupSection = document.getElementById('setup-section');
  const scannerSection = document.getElementById('scanner-section');
  const logSection = document.getElementById('log-section');
  const courseCodeInput = document.getElementById('course-code');
  const startBtn = document.getElementById('start-scan-btn');
  const stopBtn = document.getElementById('stop-scan-btn');
  const reader = document.getElementById('reader');
  const scanResult = document.getElementById('scan-result');
  const scanLog = document.getElementById('scan-log');
  const connectionStatus = document.getElementById('connection-status');
  const viewLogBtn = document.getElementById('view-log-btn');
  const logCountDisplay = document.getElementById('log-count');
  const scannerLiveCounter = document.getElementById('scanner-live-counter').querySelector('span:first-child');

  // --- STATE ---
  let html5QrCode;
  let courseCode = '';
  let scannedCodes = new Set();
  const scanSound = new Audio('scan-sound.mp3'); // Add a sound file to your folder
  let isSyncing = false; // Flag to prevent concurrent syncs
  let isHistoryView = false;
  let db;

  // --- INITIALIZATION ---
  if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(err => console.error('Service Worker registration failed:', err));
  }
  initDB();

  startBtn.addEventListener('click', startScanning);
  stopBtn.addEventListener('click', stopScanning);
  viewLogBtn.addEventListener('click', handleHistoryToggle);
  // Add a listener to ensure the camera is released if the user closes the tab/window
  window.addEventListener('beforeunload', () => {
    if (html5QrCode?.isScanning) {
      stopScanning();
    }
  });
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
  setInterval(updateConnectionStatus, 30000); // Check every 30 seconds
  updateConnectionStatus();

  // --- FUNCTIONS ---
  /**
   * Generates a simple universally unique identifier (UUID).
   * @returns {string} A UUID string.
   */
  function generateUUID() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  }

  // Icon templates for history view toggle
  const ICON_LIST_HTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 6H21M8 12H21M8 18H21M3 6H3.01M3 12H3.01M3 18H3.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        <span id="log-count-badge" class="badge hidden">0</span>`;
  const ICON_CLOSE_HTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                         <span id="log-count-badge" class="badge hidden">0</span>`;

  function handleHistoryToggle() {
    // Toggle state
    isHistoryView = !isHistoryView;

    if (isHistoryView) {
        // Show history view
        setupSection.classList.add('hidden');
        scannerSection.classList.add('hidden');
        logSection.classList.remove('hidden');
        viewLogBtn.innerHTML = ICON_CLOSE_HTML;
        viewLogBtn.setAttribute('aria-label', 'Close Scan History');
    } else {
        // Show main view
        logSection.classList.add('hidden');
        if (html5QrCode?.isScanning) {
            scannerSection.classList.remove('hidden');
            setupSection.classList.add('hidden');
        } else {
            setupSection.classList.remove('hidden');
            scannerSection.classList.add('hidden');
        }
        viewLogBtn.innerHTML = ICON_LIST_HTML;
        viewLogBtn.setAttribute('aria-label', 'View Scan History');
    }

    // Update log count display
    updateLogCount();
  }

  function initDB() {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => console.error('Database error:', event.target.errorCode);
    request.onsuccess = (event) => {
      db = event.target.result;
      console.log('Database initialised.');
      updateConnectionStatus(); // Try to sync on load
    };

    request.onupgradeneeded = (event) => {
      let db = event.target.result;
      // Use a unique ID as the keyPath for robustness, as timestamps may not be unique.
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      console.log('Database upgraded.');
    };
  }

  async function checkCameraPermission() {
    try {
      // First check if permissions API is supported
      if ('permissions' in navigator) {
        const permission = await navigator.permissions.query({ name: 'camera' });
        console.log('Camera permission state:', permission.state);
        return permission.state;
      }
      return 'unknown';
    } catch (error) {
      console.log('Permissions API not supported or failed:', error);
      return 'unknown';
    }
  }

  async function requestCameraPermission() {
    try {
      // Check current permission state first
      const permissionState = await checkCameraPermission();
      console.log('Permission state before request:', permissionState);

      if (permissionState === 'denied') {
        console.log('Camera permission was previously denied');
        return false;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      // Stop the stream immediately since we just wanted to request permission
      stream.getTracks().forEach(track => track.stop());
      console.log('Camera permission granted successfully');
      return true;
    } catch (error) {
      console.error('Camera permission request failed:', error.name, error.message);
      return false;
    }
  }

  async function startScanning() {
      // Add a check to ensure the QR scanner library has loaded.
      if (typeof Html5Qrcode === 'undefined') {
          alert('Error: The QR code scanning library failed to load. Please check your internet connection and refresh the page.');
          console.error('Html5Qrcode library is not defined. Check the script tag in your HTML file.');
          return;
      }

      courseCode = courseCodeInput.value.trim().toUpperCase();
      if (!courseCode) {
          alert('Please enter a course code.');
          return;
      }

      // Check camera permission first
      const hasPermission = await requestCameraPermission();
      if (!hasPermission) {
          showCameraPermissionError();
          return;
      }

      // If user is in history view, switch back before starting a new session
      if (isHistoryView) {
        handleHistoryToggle();
      }

      // Reset for the new session. The scannedCodes set is intentionally cleared here,
      // preventing memory leaks from long-running app usage across different sessions
      // and allowing the same student to be scanned in a different course session.
      scanLog.innerHTML = '';
      scannedCodes.clear();
      updateLogCount();
      scanResult.innerHTML = '';
      reader.innerHTML = ''; // Clear previous content (like error messages)
      scanResult.className = 'scan-feedback';

      // Clear any existing scanner instance
      if (html5QrCode) {
        html5QrCode.stop().catch(() => {}); // Ignore errors when stopping
        html5QrCode = null;
      }

      setupSection.classList.add('hidden');
      scannerSection.classList.remove('hidden');

      html5QrCode = new Html5Qrcode('reader');
      html5QrCode.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 },
            debounce: SCAN_DEBOUNCE_DELAY },
          onScanSuccess,
          onScanFailure
      ).then(() => {
          console.log('Scanner started successfully.');
          showFeedback('Camera ready. Point at a QR code to scan.', 'success');
      }).catch(err => {
          console.error('Scanner start error:', err);
          showCameraPermissionError(err);
      });
  }

  function getBrowserName() {
    const userAgent = navigator.userAgent;
    if (userAgent.includes('Chrome')) return 'Chrome';
    if (userAgent.includes('Firefox')) return 'Firefox';
    if (userAgent.includes('Safari')) return 'Safari';
    if (userAgent.includes('Edge')) return 'Edge';
    return 'your browser';
  }

  function getBrowserSpecificInstructions() {
    const browser = getBrowserName();
    const isHTTPS = location.protocol === 'https:';

    let instructions = '';

    if (!isHTTPS) {
      instructions += `
        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 4px; margin-bottom: 15px;">
          <strong>⚠️ HTTPS Required:</strong> Camera access requires a secure connection (HTTPS).
          This app may not work on localhost or HTTP sites.
        </div>
      `;
    }

    switch (browser) {
      case 'Chrome':
        instructions += `
          <strong>Chrome Instructions:</strong><br>
          1. Click the camera icon 🎥 in the address bar<br>
          2. Select "Allow" or change from "Block" to "Allow"<br>
          3. Refresh the page<br><br>

          <strong>Alternative:</strong><br>
          • Go to Chrome Settings → Privacy and security → Site Settings → Camera<br>
          • Find this site and change to "Allow"
        `;
        break;
      case 'Firefox':
        instructions += `
          <strong>Firefox Instructions:</strong><br>
          1. Click the camera icon in the address bar<br>
          2. Select "Allow" when prompted<br>
          3. Refresh the page<br><br>

          <strong>Alternative:</strong><br>
          • Go to Firefox Settings → Privacy & Security → Permissions → Camera<br>
          • Click "Settings..." and add this site to allowed list
        `;
        break;
      case 'Safari':
        instructions += `
          <strong>Safari Instructions:</strong><br>
          1. Go to Safari → Settings → Websites → Camera<br>
          2. Find this site and set to "Allow"<br>
          3. Refresh the page<br><br>

          <strong>Note:</strong> Safari requires HTTPS for camera access
        `;
        break;
      default:
        instructions += `
          <strong>General Instructions:</strong><br>
          1. Look for a camera icon in your browser's address bar<br>
          2. Click it and select "Allow"<br>
          3. Refresh the page<br><br>

          <strong>Alternative:</strong><br>
          • Check your browser's privacy/security settings<br>
          • Find camera permissions and allow for this site
        `;
    }

    return instructions;
  }

  async function showCameraPermissionError(error = null) {
    showFeedback('Camera access denied.', 'error');

    let errorMessage = 'Camera permission was denied.';

    // Check current permission state
    const permissionState = await checkCameraPermission();

    if (permissionState === 'denied') {
      errorMessage = 'Camera permission was previously blocked and must be reset.';
    }

    let specificError = '';
    if (error) {
      if (error.name === 'NotAllowedError') {
        specificError = 'Permission was denied by the user or browser settings.';
      } else if (error.name === 'NotFoundError') {
        specificError = 'No camera was found on this device.';
        errorMessage = 'No camera detected.';
      } else if (error.name === 'NotReadableError') {
        specificError = 'Camera is already in use by another application.';
        errorMessage = 'Camera is busy.';
      } else if (error.name === 'AbortError') {
        specificError = 'Camera access was aborted.';
      } else if (error.name === 'NotSupportedError') {
        specificError = 'Camera access is not supported on this browser/device.';
      }
    }

    const instructions = getBrowserSpecificInstructions();

    reader.innerHTML = `
      <div style="padding: 20px; text-align: center; color: #7f1d1d; background-color: #fef2f2; border-radius: 8px; max-width: 500px; margin: 0 auto;">
          <div style="font-size: 2em; margin-bottom: 10px;">📷</div>
          <p style="font-weight: bold; margin-bottom: 10px; font-size: 1.1em;">${errorMessage}</p>
          ${specificError ? `<p style="margin-bottom: 15px; font-style: italic;">${specificError}</p>` : ''}
          <div style="font-size: 0.9em; line-height: 1.6; text-align: left; background-color: #f8f9fa; padding: 15px; border-radius: 6px;">
              ${instructions}
          </div>
          <div style="margin-top: 20px;">
            <button onclick="location.reload()" style="
                margin-right: 10px;
                padding: 10px 20px;
                background-color: #4f46e5;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 0.9em;
            ">
                Try Again
            </button>
            <button onclick="document.getElementById('setup-section').classList.remove('hidden'); document.getElementById('scanner-section').classList.add('hidden');" style="
                padding: 10px 20px;
                background-color: #6b7280;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 0.9em;
            ">
                Go Back
            </button>
          </div>
      </div>`;
  }

  function stopScanning() {
      if (html5QrCode?.isScanning) {
          html5QrCode.stop().then(() => console.log('Scanner stopped.')).catch(err => console.error('Scanner stop error:', err));
      }
      html5QrCode = null;
      setupSection.classList.remove('hidden');
      scannerSection.classList.add('hidden');
  }

  function onScanSuccess(decodedText, decodedResult) {
      // 1. Validate Data
      if (!decodedText) {
        showFeedback('Invalid QR Code. Please scan again.', 'error');
        return;
      }

      // 2. Prevent Duplicate Scans for this session
      if (scannedCodes.has(decodedText)) {
        showFeedback(`Already Scanned: ${decodedText}`, 'warning');
        return;
      }

      // --- Feedback ---
      scanSound.play().catch(e => console.log("Sound play failed"));
      if ('vibrate' in navigator) navigator.vibrate(100);
      showFeedback(`Success: ${decodedText}`, 'success');
      scannedCodes.add(decodedText);

      const record = {
        id: generateUUID(),
        courseCode: courseCode,
        indexNumber: decodedText,
        timestamp: new Date().toISOString()
      };
      
      logToScreen(record);
      queueData(record); // Always queue data first for reliability
      syncOfflineData(); // Attempt to sync immediately if online  
    }

  function onScanFailure(error) {
      // This is called continuously when no QR code is found.
      // We can add logic here to show a "searching" message if needed,
      // but for now, we keep it silent to avoid UI flicker.
  }

  function showFeedback(message, type) {
    scanResult.textContent = message;
    scanResult.className = `scan-feedback ${type}`; // e.g., 'success', 'error', 'warning'
  }

  function logToScreen(record) {
      const li = document.createElement('li');
      li.className = 'scan-entry-new'; // Add class for animation
      // Add a data-id attribute to easily find this element later for status updates.
      li.setAttribute('data-id', record.id);

      const statusSpan = document.createElement('span');

      const dataSpan = document.createElement('span');
      dataSpan.className = 'data';
      dataSpan.textContent = record.indexNumber;

      const timeSpan = document.createElement('span');
      timeSpan.className = 'timestamp';
      timeSpan.textContent = new Date(record.timestamp).toLocaleTimeString();

      // Add a status indicator icon
      statusSpan.className = 'status-icon pending';
      statusSpan.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 8V12L14 14M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      li.appendChild(statusSpan);
      li.appendChild(dataSpan);
      li.appendChild(timeSpan);

      scanLog.prepend(li);
      updateLogCount();

      // Remove the animation class after it has played
      setTimeout(() => {
          li.classList.remove('scan-entry-new');
      }, 500);
  }

  function updateLogCount() {
    const count = scanLog.children.length;
    if(logCountDisplay) logCountDisplay.textContent = count; // Update modal counter
    if(scannerLiveCounter) scannerLiveCounter.textContent = count; // Update live scanner counter

    // Get the badge element fresh each time to avoid reference issues
    const currentLogCountBadge = document.getElementById('log-count-badge');
    if (count > 0) {
      if (currentLogCountBadge) {
        currentLogCountBadge.textContent = count;
        currentLogCountBadge.classList.remove('hidden');
      }
    } else {
      if (currentLogCountBadge) {
        currentLogCountBadge.classList.add('hidden');
      }
    }
  }

  function queueData(record) {
      if (!db) {
        console.error("Database not available. Can't queue data.");
        return;
      }
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      transaction.oncomplete = () => {
        console.log('Transaction completed: data queued successfully.');
      };
      transaction.onerror = (event) => {
        console.error('Transaction error while queuing data:', event.target.error);
      };
      const store = transaction.objectStore(STORE_NAME);
      store.add(record);
      
  }

  // --- OFFLINE SYNC & CONNECTION STATUS ---
  function updateConnectionStatus() {
      const statusText = connectionStatus.querySelector('.status-text');
      if (navigator.onLine) {
          connectionStatus.classList.replace('offline', 'online');
          if (statusText) statusText.textContent = 'Online';
          syncOfflineData();
      } else {
          connectionStatus.classList.replace('online', 'offline');
          if (statusText) statusText.textContent = 'Offline';
      }
  }

  async function syncOfflineData() {
    // Prevent concurrent sync attempts and only run if online and DB is ready.
    if (!db || !navigator.onLine || isSyncing) return;

    isSyncing = true;
    console.log('Starting offline data sync...');

    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onerror = (e) => {
      console.error('Failed to get offline queue:', e.target.error);
      isSyncing = false;
    };

    request.onsuccess = async (e) => {
      const records = e.target.result;
      if (records.length === 0) {
        console.log('Offline queue is empty.');
        isSyncing = false;
        return;
      }

      console.log(`Attempting to sync ${records.length} offline record(s)...`);
      try {
        // Send all records in a single batch.
        // IMPORTANT: 'no-cors' mode was removed. This is the ONLY way to
        // confirm the data was actually received successfully and prevent data loss.
        const response = await fetch(WEB_APP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' }, // Change to text/plain to avoid preflight
          body: JSON.stringify(records) // Send the entire array of records
        });

        // We must check if the server responded with a success status code.
        if (!response.ok) {
          // If the server returns an error (e.g., 401, 500), we throw an error
          // to prevent deleting the local records. The sync will be retried later.
          throw new Error(`Sync failed with status: ${response.status}`);
        }

        console.log('Sync successful, server responded OK.');

        // If the fetch is successful, clear all the synced records from the local DB.
        const successfullySyncedIds = records.map(r => r.id);
        if (successfullySyncedIds.length > 0) {
          const deleteTransaction = db.transaction([STORE_NAME], 'readwrite');
          const deleteStore = deleteTransaction.objectStore(STORE_NAME);
          successfullySyncedIds.forEach(id => deleteStore.delete(id));

          // Update UI for synced items
          successfullySyncedIds.forEach(id => {
            const logEntry = scanLog.querySelector(`li[data-id="${id}"]`);
            if (logEntry) {
              const statusIcon = logEntry.querySelector('.status-icon');
              statusIcon.className = 'status-icon synced';
              statusIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
            }
          });
          console.log(`Successfully synced and removed ${successfullySyncedIds.length} records.`);
        }
    } catch (error) {
      console.error('Sync failed, will retry later.', error);
      // Don't clear the queue if the sync fails.
    } finally {
      isSyncing = false;
    }
  };
}
});
