const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

exports.handler = async (event, context) => {
    // Fase 0: Verificación de Vida
    console.log("Iniciando Protocolo V21...");
    let report = ["--- INICIO DEL REPORTE ---"];

    try {
        // 1. Verificación de Credenciales
        if (!process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
            throw new Error("ERROR FATAL: No se detectan las variables de entorno (PRIVATE_KEY o EMAIL).");
        }

        // 2. Conexión a Google
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        await doc.loadInfo();
        report.push("Conexión con Sheets: OK");

        // 3. Verificación de la Hoja de Sistema (_SystemState)
        // BUSCAMOS EXACTAMENTE CON EL GUIÓN BAJO
        const SHEET_NAME = '_SystemState';
        const stateSheet = doc.sheetsByTitle[SHEET_NAME];
        
        if (!stateSheet) {
            throw new Error(`ERROR CRÍTICO: No encuentro la hoja llamada '${SHEET_NAME}'. Verifica que el nombre en el Excel sea idéntico.`);
        }
        report.push(`Hoja '${SHEET_NAME}' encontrada.`);

        // 4. Lectura de Memoria
        await stateSheet.loadHeaderRow();
        const stateRows = await stateSheet.getRows();
        
        // Buscamos la fila del token de forma segura
        let tokenRow = stateRows.find(r => r.get('key') === 'drivePageToken');
        
        // Auto-reparación: Si no existe la fila, intentamos crearla o usar valor nulo
        let currentToken = null;
        if (tokenRow) {
            currentToken = tokenRow.get('value');
            report.push(`Marcador de memoria leído: ${currentToken ? 'Continuando...' : 'Inicio limpio'}`);
        } else {
            report.push("AVISO: No se encontró la fila 'drivePageToken'. Se procesará desde el inicio.");
        }

        // 5. Barrido de Drive (Micro-Lote de 50 para prueba)
        // Reducimos a 50 para garantizar que NUNCA ocurra timeout en esta prueba
        const res = await drive.files.list({
            q: "trashed = false and mimeType contains 'image/'",
            fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
            pageSize: 50, 
            pageToken: currentToken || null,
            supportsAllDrives: true, includeItemsFromAllDrives: true
        });

        const files = res.data.files || [];
        const nextToken = res.data.nextPageToken;
        report.push(`Drive respondió: ${files.length} archivos obtenidos.`);

        // 6. Procesamiento de Links
        const freshLinksMap = new Map();
        files.forEach(f => {
            let link = f.webContentLink || (f.thumbnailLink ? f.thumbnailLink.split('=')[0] + '=s0' : null);
            if (link) {
                // HTTPS Forzado
                freshLinksMap.set(f.id, link.replace(/^http:\/\//i, 'https://'));
            }
        });

        // 7. Escritura en Sheets (Modo Seguro Fila por Fila)
        if (freshLinksMap.size > 0) {
            const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
            
            for (const title of targetSheets) {
                const sheet = doc.sheetsByTitle[title];
                if (!sheet) continue;

                await sheet.loadHeaderRow();
                const rows = await sheet.getRows();
                const h = sheet.headerValues;
                const keyId = h.includes('fileId') ? 'fileId' : null;
                const keyUrl = h.includes('imageUrl') ? 'imageUrl' : (h.includes('logoUrl') ? 'logoUrl' : null);

                if (!keyId || !keyUrl) continue;

                let updates = 0;
                for (const row of rows) {
                    const fileId = row.get(keyId);
                    if (fileId && freshLinksMap.has(fileId.trim())) {
                        const newLink = freshLinksMap.get(fileId.trim());
                        if (row.get(keyUrl) !== newLink) {
                            row.set(keyUrl, newLink);
                            await row.save(); // Guardado
                            updates++;
                        }
                    }
                }
                if (updates > 0) report.push(`[${title}] Actualizados: ${updates}`);
            }
        }

        // 8. Guardar Memoria (Solo si la fila existe)
        if (tokenRow) {
            tokenRow.set('value', nextToken || '');
            await tokenRow.save();
            report.push("Memoria actualizada correctamente.");
        }

        report.push("--- PROCESO FINALIZADO CON ÉXITO ---");
        
        return {
            statusCode: 200,
            body: report.join('\n')
        };

    } catch (error) {
        // Captura cualquier error y muéstralo en pantalla en lugar de morir
        console.error(error);
        return {
            statusCode: 200, // Respondemos 200 para que Netlify muestre el mensaje
            body: `⚠️ ERROR DIAGNÓSTICO:\n${error.message}\n\nSTACK:\n${error.stack}`
        };
    }
};
