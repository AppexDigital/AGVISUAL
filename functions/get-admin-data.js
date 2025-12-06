// functions/get-admin-data.js
// v11.0 - HIDRATACIÓN TOTAL (Con Paginación Infinita)
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
  // Evitar cacheo en el navegador para forzar la petición de links frescos
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

    // 1. Cargar datos de Sheets
    const promises = requestedSheets.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) return { title, data: [] };
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            return { title, data: rowsToObjects(sheet, rows) };
        } catch (e) {
            console.warn(`Error hoja ${title}: ${e.message}`);
            return { title, data: [] };
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => adminData[res.title] = res.data);

    // --- HIDRATACIÓN ROBUSTA (PAGINACIÓN COMPLETA) ---
    if (requestedSheets.some(s => ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'].includes(s))) {
        try {
            const freshLinksMap = new Map();
            let pageToken = null;

            // BUCLE DE PAGINACIÓN: Seguimos pidiendo mientras Google diga que hay más
            do {
                const driveRes = await drive.files.list({
                    // Filtramos SOLO imágenes para no llenar la lista con basura
                    q: "mimeType contains 'image/' and trashed = false",
                    fields: 'nextPageToken, files(id, thumbnailLink)',
                    pageSize: 1000, 
                    pageToken: pageToken, // Pedimos la página siguiente
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true
                });

                // Procesamos este lote
                if (driveRes.data.files) {
                    driveRes.data.files.forEach(f => {
                        if (f.thumbnailLink) {
                            // Generamos el link fresco
                            const cleanLink = f.thumbnailLink.split('=')[0];
                            const highResLink = `${cleanLink}=s1600`;
                            freshLinksMap.set(f.id, highResLink);
                        }
                    });
                }

                // Actualizamos el token para la siguiente vuelta (o null si terminó)
                pageToken = driveRes.data.nextPageToken;

            } while (pageToken); // Repetir si hay token

            // Inyección de links frescos
            const imageSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
            imageSheets.forEach(sheetKey => {
                if (adminData[sheetKey]) {
                    adminData[sheetKey] = adminData[sheetKey].map(row => {
                        // Usamos trim() para evitar errores por espacios invisibles en el ID
                        const cleanId = row.fileId ? row.fileId.trim() : null;
                        
                        if (cleanId && freshLinksMap.has(cleanId)) {
                            row.imageUrl = freshLinksMap.get(cleanId);
                        }
                        if (sheetKey === 'ClientLogos' && cleanId && freshLinksMap.has(cleanId)) {
                            row.logoUrl = freshLinksMap.get(cleanId);
                        }
                        return row;
                    });
                }
            });

        } catch (driveError) {
            console.error("Error crítico en hidratación:", driveError);
        }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(adminData),
    };

  } catch (error) {
    console.error('Data Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
