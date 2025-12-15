// functions/scheduled-refresh.js
// V60.0 - BATCH UPDATE (Velocidad Extrema para Catálogos Grandes)

const { schedule } = require('@netlify/functions');

const myHandler = async (event, context) => {
    // Cronómetro (8.5s es suficiente para procesar miles de filas en modo Batch)
    const TIME_LIMIT = 8500;
    const startTime = Date.now();
    let logs = [];
    
    console.log(">>> ROBOT INICIADO: Modo Batch Update (Ultra Rápido)...");

    try {
        // Importación Dinámica
        const { GoogleSpreadsheet } = await import('google-spreadsheet');
        const { JWT } = await import('google-auth-library');
        const { google } = await import('googleapis');

        // Credenciales
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            throw new Error("Faltan credenciales.");
        }

        // Autenticación
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        await doc.loadInfo();
        logs.push("Conexión Sheets OK.");

        // --- BARRIDO DRIVE (Igual que antes, funciona perfecto) ---
        const freshLinksMap = new Map();
        let pageToken = null;
        
        try {
            do {
                if (Date.now() - startTime > TIME_LIMIT) break;

                const res = await drive.files.list({
                    q: "trashed = false and mimeType contains 'image/'",
                    corpora: 'allDrives',
                    fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
                    pageSize: 500, // Aumentamos lote de lectura pues Drive es rápido
                    pageToken: pageToken,
                    supportsAllDrives: true, includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        if (f.thumbnailLink) {
                            // Formato Visual =s0
                            const link = f.thumbnailLink.split('=')[0] + '=s0';
                            freshLinksMap.set(f.id, link.replace(/^http:\/\//i, 'https://'));
                        }
                    });
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
            logs.push(`Drive: ${freshLinksMap.size} archivos escaneados.`);
        } catch (e) {
            logs.push(`Warn Drive: ${e.message}`);
        }

        // --- ESCRITURA EN BLOQUE (EL CAMBIO CLAVE) ---
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
        let totalChanges = 0;

        for (const title of targetSheets) {
            // Chequeo de tiempo por Hoja (no por fila)
            if (Date.now() - startTime > TIME_LIMIT) {
                logs.push("Tiempo agotado entre hojas.");
                break;
            }

            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            // 1. Cargamos TODA la data de la hoja en una sola petición
            await sheet.loadHeaderRow();
            await sheet.loadCells(); // <--- ESTO CARGA TODO EL GRID
            
            const headers = sheet.headerValues;
            const colIdIdx = headers.indexOf('fileId');
            const colUrlName = headers.includes('imageUrl') ? 'imageUrl' : (headers.includes('logoUrl') ? 'logoUrl' : null);
            const colUrlIdx = headers.indexOf(colUrlName);

            if (colIdIdx === -1 || colUrlIdx === -1) continue;

            let sheetChanges = 0;
            // 2. Iteramos en memoria (Esto toma microsegundos)
            // Empezamos en fila 1 (0 es header)
            for (let r = 1; r < sheet.rowCount; r++) {
                const cellId = sheet.getCell(r, colIdIdx);
                const cellUrl = sheet.getCell(r, colUrlIdx);
                
                const fileId = cellId.value;
                if (fileId && typeof fileId === 'string') {
                    const cleanId = fileId.trim();
                    if (freshLinksMap.has(cleanId)) {
                        const newLink = freshLinksMap.get(cleanId);
                        if (cellUrl.value !== newLink) {
                            // Actualizamos EN MEMORIA
                            cellUrl.value = newLink;
                            sheetChanges++;
                            totalChanges++;
                        }
                    }
                }
            }

            // 3. Guardamos TODO el lote de una sola vez
            if (sheetChanges > 0) {
                await sheet.saveUpdatedCells(); // <--- 1 SOLA PETICIÓN HTTP
                logs.push(`[${title}] ${sheetChanges} actualizados (Batch).`);
            }
        }

        const finalMsg = `FIN BATCH. Cambios: ${totalChanges}. Logs: ${logs.join(' | ')}`;
        console.log(finalMsg);
        return { statusCode: 200, body: finalMsg };

    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: error.message };
    }
};

// PRUEBA MANUAL: 9:XX (Ajusta esto a tu hora actual + 2 min para probar)
// OJO: Recuerda cambiar esto a "0 6,18 * * *" para producción.
// Hora actual aprox CR: 9:15 -> UTC: 15:15
module.exports.handler = schedule("8 17 * * *", myHandler);
