// functions/get-admin-data.js
// v13.0 - ESTRATEGIA BARRIDO MASIVO (Segura para 5000+ fotos)
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
  // Headers para evitar que el navegador guarde links viejos
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

    // --- HIDRATACIÓN MASIVA (BARRIDO TOTAL) ---
    // Solo si hay hojas de imágenes involucradas
    if (requestedSheets.some(s => ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'].includes(s))) {
        
        try {
            const freshLinksMap = new Map();
            let pageToken = null;

            // BUCLE: Pedimos páginas de 1000 en 1000 hasta terminar
            do {
                const driveRes = await drive.files.list({
                    q: "mimeType contains 'image/' and trashed = false", // <--- FILTRO RESTAURADO
                    fields: 'nextPageToken, files(id, thumbnailLink)',
                    pageSize: 1000, 
                    pageToken: pageToken,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true
                });

                if (driveRes.data.files) {
                    driveRes.data.files.forEach(f => {
                        if (f.thumbnailLink) {
                            const cleanLink = f.thumbnailLink.split('=')[0];
                            // REGLA DE ORO: Forzar HTTPS siempre
                            const cleanLink = f.thumbnailLink.split('=')[0].replace(/^http:\/\//i, 'https://'); 
                            freshLinksMap.set(f.id, `${secureLink}=s1600`);
                        }
                    });
                }

                pageToken = driveRes.data.nextPageToken; // ¿Hay más?
            } while (pageToken); // Si hay token, repetimos el bucle

            // Inyección de links frescos en los datos
            const imageSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
            imageSheets.forEach(sheetKey => {
                if (adminData[sheetKey]) {
                    adminData[sheetKey] = adminData[sheetKey].map(row => {
                        const cleanId = row.fileId ? row.fileId.trim() : null;

                      // LÓGICA DE HIERRO:
                        // 1. Si hay ID y hay link fresco -> Usar link fresco.
                        // 2. Si hay ID pero NO hay link fresco -> Construir link directo de respaldo (lh3.googleusercontent.com/d/ID).
                        // 3. Si no hay ID -> Dejar vacío.
                        if (cleanId) {
                            if (freshLinksMap.has(cleanId)) {
                                row.imageUrl = freshLinksMap.get(cleanId);
                                if (sheetKey === 'ClientLogos') row.logoUrl = freshLinksMap.get(cleanId);
                            } else {
                                // Fallback de emergencia: Link directo de descarga (suele funcionar para visualización básica)
                                const fallbackUrl = `https://lh3.googleusercontent.com/d/${cleanId}`;
                                row.imageUrl = fallbackUrl;
                                if (sheetKey === 'ClientLogos') row.logoUrl = fallbackUrl;
                            }
                        }
                        return row;
                    });
                }
            });

        } catch (driveError) {
            console.error("Error en barrido de Drive:", driveError);
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
