const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  const drive = google.drive({ version: 'v3', auth });
  return { doc, drive };
}

function rowsToObjects(sheet, rows) {
  if (!rows || rows.length === 0) return [];
  const headers = sheet.headerValues || [];
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      let val = row.get(header);
      if (val === undefined || val === null) val = '';
      obj[header] = val;
      obj[header.toLowerCase().trim()] = val;
    });
    return obj;
  });
}

exports.handler = async (event, context) => {
  const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
  };

  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado.' }) };
  }

  try {
    const { doc, drive } = await getServices();
    
    let requestedSheets = [];
    if (event.queryStringParameters && event.queryStringParameters.sheets) {
        requestedSheets = event.queryStringParameters.sheets.split(',');
    } else {
        requestedSheets = ['Projects', 'ProjectImages', 'Bookings']; 
    }

    const adminData = {};
    const promises = requestedSheets.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) return { title, data: [] };
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            return { title, data: rowsToObjects(sheet, rows) };
        } catch (e) {
            return { title, data: [] };
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => adminData[res.title] = res.data);

    // --- HIDRATACIÓN ---
    const imageSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
    if (requestedSheets.some(s => imageSheets.includes(s))) {
        
        const freshLinksMap = new Map();
        
        // 1. BARRIDO (Filtro RESTAURADO para evitar error 502)
        try {
            let pageToken = null;
            let pageCount = 0;
            
            do {
                const driveRes = await drive.files.list({
                    q: "mimeType contains 'image/' and trashed = false", // <--- FILTRO CORRECTO
                    fields: 'nextPageToken, files(id, thumbnailLink)',
                    pageSize: 1000, 
                    pageToken: pageToken,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true
                });

                if (driveRes.data.files) {
                    driveRes.data.files.forEach(f => {
                        if (f.thumbnailLink) {
                            // Variable renombrada para evitar conflictos
                            const linkBarrido = f.thumbnailLink.split('=')[0].replace(/^http:\/\//i, 'https://');
                            freshLinksMap.set(f.id, `${linkBarrido}=s1600`);
                        }
                    });
                }
                pageToken = driveRes.data.nextPageToken;
                pageCount++;
                if (pageCount > 10) break; // Límite de seguridad

            } while (pageToken);
        } catch (e) { console.error("Error barrido:", e); }

        // 2. FASE RESCATE (Limitada)
        const missingIds = new Set();
        imageSheets.forEach(sheetKey => {
            if (adminData[sheetKey]) {
                adminData[sheetKey].forEach(row => {
                    const id = row.fileId ? row.fileId.trim() : null;
                    if (id && !freshLinksMap.has(id)) missingIds.add(id);
                });
            }
        });

        if (missingIds.size > 0 && missingIds.size < 20) {
            const missingArray = Array.from(missingIds);
            await Promise.all(missingArray.map(async (id) => {
                try {
                    const res = await drive.files.get({ fileId: id, fields: 'thumbnailLink', supportsAllDrives: true });
                    if (res.data.thumbnailLink) {
                        // Variable renombrada para evitar conflictos
                        const linkRescate = res.data.thumbnailLink.split('=')[0].replace(/^http:\/\//i, 'https://');
                        freshLinksMap.set(id, `${linkRescate}=s1600`);
                    }
                } catch (err) {}
            }));
        }

        // 3. INYECCIÓN
        imageSheets.forEach(sheetKey => {
            if (adminData[sheetKey]) {
                adminData[sheetKey] = adminData[sheetKey].map(row => {
                    const cleanId = row.fileId ? row.fileId.trim() : null;
                    if (cleanId && freshLinksMap.has(cleanId)) {
                        const finalLink = freshLinksMap.get(cleanId);
                        row.imageUrl = finalLink;
                        if (sheetKey === 'ClientLogos') row.logoUrl = finalLink;
                    }
                    return row;
                });
            }
        });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(adminData),
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
