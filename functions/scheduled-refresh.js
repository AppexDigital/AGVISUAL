// functions/scheduled-refresh.js
// V52.0 - FORMATO VISUAL ESTRICTO (=s0)

const { schedule } = require('@netlify/functions');

const myHandler = async (event, context) => {
    // Cronómetro de seguridad
    const TIME_LIMIT = 8500;
    const startTime = Date.now();
    let logs = [];
    
    console.log(">>> ROBOT INICIADO: Mantenimiento de Links (Formato Visual)...");

    try {
        // Carga Dinámica
        const { GoogleSpreadsheet } = await import('google-spreadsheet');
        const { JWT } = await import('google-auth-library');
        const { google } = await import('googleapis');

        // Credenciales
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            throw new Error("Faltan credenciales de entorno.");
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

        // --- BARRIDO DRIVE ---
        const freshLinksMap = new Map();
        let pageToken = null;
        
        try {
            do {
                if (Date.now() - startTime > TIME_LIMIT) break;

                const res = await drive.files.list({
                    q: "trashed = false and mimeType contains 'image/'",
                    corpora: 'allDrives', // Soporte Shared Drive
                    fields: 'nextPageToken, files(id, thumbnailLink)', // Solo pedimos thumbnailLink
                    pageSize: 200, 
                    pageToken: pageToken,
                    supportsAllDrives: true, 
                    includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        // --- CORRECCIÓN DE FORMATO ---
                        // Ignoramos webContentLink. Usamos estrictamente thumbnailLink.
                        // Quitamos el tamaño por defecto y ponemos =s0 (Original Size)
                        if (f.thumbnailLink) {
                            const visualLink = f.thumbnailLink.split('=')[0] + '=s0';
                            // Forzamos HTTPS y guardamos
                            freshLinksMap.set(f.id, visualLink.replace(/^http:\/\//i, 'https://'));
                        }
                    });
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
            logs.push(`Drive: ${freshLinksMap.size} archivos visuales escaneados.`);
        } catch (e) {
            logs.push(`Advertencia Drive: ${e.message}`);
        }

        // Actualización en Sheets
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
        let changes = 0;

        for (const title of targetSheets) {
            if (Date.now() - startTime > TIME_LIMIT) break;
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            const headers = sheet.headerValues;
            
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
                    // Actualizamos si es diferente
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
        return { statusCode: 200, body: finalMsg };

    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: error.message };
    }
};

//module.exports.handler = schedule("0 6,18 * * *", myHandler);

// CAMBIO TEMPORAL PARA PRUEBA (8:36 AM CR / 14:36 UTC)
module.exports.handler = schedule("5 15 * * *", myHandler);
