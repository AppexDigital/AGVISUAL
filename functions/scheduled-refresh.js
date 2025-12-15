// functions/scheduled-refresh.js
// V50.0 - LÓGICA COMPLETA EN MODO HÍBRIDO (CommonJS + Dynamic Import)

const { schedule } = require('@netlify/functions');

const myHandler = async (event, context) => {
    // 1. Cronómetro de Seguridad (8.5 segundos para no llegar al límite de 10s)
    const TIME_LIMIT = 8500;
    const startTime = Date.now();
    let logs = [];
    
    console.log(">>> ROBOT INICIADO: Mantenimiento de Links...");

    try {
        // --- CARGA DINÁMICA DE LIBRERÍAS (El secreto del éxito) ---
        const { GoogleSpreadsheet } = await import('google-spreadsheet');
        const { JWT } = await import('google-auth-library');
        const { google } = await import('googleapis');

        // 2. Verificación de Credenciales
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            throw new Error("Faltan credenciales de entorno.");
        }

        // 3. Autenticación (Sintaxis V5 Moderna)
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        await doc.loadInfo();
        logs.push("Conexión Sheets OK.");

        // 4. Barrido Rápido de Drive (Lote Seguro de 200)
        const freshLinksMap = new Map();
        let pageToken = null;
        
        try {
            do {
                if (Date.now() - startTime > TIME_LIMIT) break;

                const res = await drive.files.list({
                    q: "trashed = false and mimeType contains 'image/'",
                    fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
                    pageSize: 200, 
                    pageToken: pageToken,
                    supportsAllDrives: true, includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        // Generar Link Robusto =s0 (Tamaño original / Descarga)
                        let link = f.webContentLink;
                        if (!link && f.thumbnailLink) {
                            link = f.thumbnailLink.split('=')[0] + '=s0';
                        }
                        if (link) {
                            freshLinksMap.set(f.id, link.replace(/^http:\/\//i, 'https://'));
                        }
                    });
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
            logs.push(`Drive: ${freshLinksMap.size} archivos escaneados.`);
        } catch (e) {
            logs.push(`Advertencia Drive: ${e.message}`);
        }

        // 5. Actualización en Sheets
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
        let changes = 0;

        for (const title of targetSheets) {
            if (Date.now() - startTime > TIME_LIMIT) break;

            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            // Carga optimizada V5
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            const headers = sheet.headerValues;
            
            // Detectar columnas
            const keyId = headers.includes('fileId') ? 'fileId' : null;
            const keyUrl = headers.includes('imageUrl') ? 'imageUrl' : (headers.includes('logoUrl') ? 'logoUrl' : null);

            if (!keyId || !keyUrl) continue;

            let sheetChanges = 0;
            for (const row of rows) {
                if (Date.now() - startTime > TIME_LIMIT) break;

                const fileId = row.get(keyId);
                const currentUrl = row.get(keyUrl);

                if (fileId && freshLinksMap.has(fileId.trim())) {
                    const newLink = freshLinksMap.get(fileId.trim());
                    // Solo gastamos tiempo guardando si es diferente
                    if (currentUrl !== newLink) {
                        row.set(keyUrl, newLink);
                        await row.save();
                        sheetChanges++;
                        changes++;
                    }
                }
            }
            if (sheetChanges > 0) logs.push(`[${title}] ${sheetChanges} actualizados.`);
        }

        const finalMsg = `MANTENIMIENTO FINALIZADO. Cambios: ${changes}. Logs: ${logs.join(' | ')}`;
        console.log(finalMsg);

        return {
            statusCode: 200,
            body: finalMsg
        };

    } catch (error) {
        console.error("Error Crítico:", error);
        return { statusCode: 500, body: error.message };
    }
};

// Exportamos con el Programador
// 00:00 y 12:00 (Aprox Costa Rica)
module.exports.handler = schedule("0 6,18 * * *", myHandler);
