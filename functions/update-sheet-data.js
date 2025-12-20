// functions/update-sheet-data.js  v5.1
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { validateGoogleToken } = require('./google-auth-helper');

// --- 1. CONEXIÓN A GOOGLE (HELPERS) ---
async function getServices(publicAuth = false) {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return { doc, drive: google.drive({ version: 'v3', auth }) };
}

function getRealHeader(sheet, name) {
    if (!sheet || !sheet.headerValues) return undefined;
    const headers = sheet.headerValues;
    const target = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return headers.find(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '') === target);
}

function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? dataObj[key] : undefined;
}

async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        await childSheet.loadHeaderRow();
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        if (!header) return;
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        for (const row of rowsToDelete) { await row.delete(); }
    } catch (e) { console.warn(`Error cascada ${childSheetName}:`, e.message); }
}

// --- 2. SISTEMA DE CORREOS PRO ---
async function sendReservationEmails(doc, bookingData, allOperations) {
    try {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.warn("⚠️ SMTP no configurado.");
            return;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });

        // --- A. OBTENER IDENTIDAD DEL NEGOCIO (Lógica Multi-Hoja) ---
        let config = {
            adminEmail: process.env.SMTP_USER,
            companyName: "AG Visual",
            logoUrl: "", 
            adminUrl: "#", 
            webUrl: "#",   
            phone: "",
            contactEmail: ""
        };
        
        try {
            // 1. Hoja 'Identidad' (Texto: key, value)
            const idSheet = doc.sheetsByTitle['Identidad'];
            if (idSheet) {
                await idSheet.loadHeaderRow();
                const rows = await idSheet.getRows();
                
                // Helper para buscar valor por key
                const getVal = (k) => {
                    const r = rows.find(row => row.get('key') === k);
                    return r ? r.get('value') : "";
                };

                const emailSheet = getVal('contact_email');
                if(emailSheet && emailSheet.includes('@')) config.adminEmail = emailSheet;
                
                config.companyName = getVal('legal_commercial_name') || config.companyName;
                config.adminUrl = getVal('admin_url');
                config.webUrl = getVal('website_url');
                config.phone = getVal('contact_phone');
                config.contactEmail = getVal('contact_email');
            }

            // 2. Hoja 'ImagenesIdentidad' (Logo: key='logo_white', imageUrl)
            const imgSheet = doc.sheetsByTitle['ImagenesIdentidad'];
            if (imgSheet) {
                await imgSheet.loadHeaderRow();
                const rows = await imgSheet.getRows();
                // Buscamos la fila donde 'key' sea 'logo_white'
                const logoRow = rows.find(r => r.get('key') === 'logo_white');
                if (logoRow) {
                    config.logoUrl = logoRow.get('imageUrl');
                }
            }
        } catch (e) { console.warn("Error leyendo Identidad:", e.message); }


        // --- B. PROCESAR ITEMS (Fotos, Fechas y Precios) ---
        const detailsOps = allOperations.filter(op => 
            op.sheet === 'BookingsDetails' && op.action === 'add' && String(op.data.bookingId) === String(bookingData.id)
        );

        let subtotalGeneral = 0;
        let ivaGeneral = 0;

        const generateRows = (isAdmin) => detailsOps.map(d => {
            const price = parseFloat(d.data.lineTotal || 0);
            const imgUrl = d.data.itemImage || ""; 
            const hasTax = String(d.data.itemHasTax).toLowerCase() === 'si';
            
            // Desglose de IVA inverso
            let lineBase = price;
            let lineTax = 0;

            if (hasTax) {
                lineBase = price / 1.13;
                lineTax = price - lineBase;
            }

            subtotalGeneral += lineBase;
            ivaGeneral += lineTax;

            const dateStr = `${new Date(d.data.startDate).toLocaleDateString()} - ${new Date(d.data.endDate).toLocaleDateString()}`;
            
            const imgHtml = imgUrl 
                ? `<img src="${imgUrl}" alt="img" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px;">` 
                : `<div style="width: 50px; height: 50px; background: #eee; border-radius: 4px; display:flex; align-items:center; justify-content:center; font-size:10px; color:#999;">Sin Foto</div>`;

            if (isAdmin) {
                return `
                <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #eee;">${imgHtml}</td>
                    <td style="padding: 10px; border-bottom: 1px solid #eee;">
                        <strong>${d.data.itemName}</strong><br>
                        <span style="font-size: 12px; color: #666;">${dateStr}</span>
                    </td>
                    <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">$${price.toFixed(2)}</td>
                </tr>`;
            } else {
                return `
                <tr>
                    <td style="padding: 10px; border-bottom: 1px solid #333;">${imgHtml}</td>
                    <td style="padding: 10px; border-bottom: 1px solid #333; color: #fff;">
                        ${d.data.itemName}
                    </td>
                    <td style="padding: 10px; border-bottom: 1px solid #333; text-align: right; color: #fff;">$${price.toFixed(2)}</td>
                </tr>`;
            }
        }).join('');

        const rowsAdmin = generateRows(true);
        // Reiniciamos contadores para recalcular correctamente o usamos los valores ya acumulados
        // Nota: Como map() corre la función, los acumuladores se sumarían doble si llamamos a generateRows dos veces.
        // Corrección: Reiniciamos a 0 antes de generar para cliente.
        subtotalGeneral = 0; ivaGeneral = 0;
        const rowsClient = generateRows(false); 


        // --- C. PLANTILLA CLIENTE (Oscuro + Logo Blanco) ---
        const logoHeader = config.logoUrl 
            ? `<img src="${config.logoUrl}" alt="${config.companyName}" style="max-width: 150px; height: auto;">`
            : `<h1 style="margin: 0; font-family: 'Garamond', serif; letter-spacing: 2px; color: #fff;">${config.companyName}</h1>`;

        const clientHtml = `
            <div style="font-family: 'Helvetica', sans-serif; max-width: 600px; margin: 0 auto; background-color: #000; color: #fff;">
                <div style="padding: 40px 20px; text-align: center; border-bottom: 1px solid #333;">
                    ${logoHeader}
                </div>
                <div style="padding: 30px;">
                    <h2 style="color: #fff; margin-top: 0; text-align: center; font-weight: 300;">Solicitud Recibida</h2>
                    <p style="text-align: center; color: #aaa; margin-bottom: 30px;">
                        Hola <strong>${bookingData.customerName}</strong>, hemos recibido tu solicitud. 
                        Validaremos la disponibilidad y te contactaremos pronto.
                    </p>
                    <div style="background-color: #111; padding: 15px; border-radius: 8px; margin-bottom: 30px; text-align: center; border: 1px solid #333;">
                        <span style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Código de Reserva</span><br>
                        <span style="font-size: 24px; font-weight: bold; letter-spacing: 2px;">${bookingData.id}</span>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                        ${rowsClient}
                    </table>
                    <div style="text-align: right; border-top: 1px solid #333; padding-top: 15px;">
                        <p style="margin: 5px 0; color: #aaa; font-size: 14px;">Subtotal: $${subtotalGeneral.toFixed(2)}</p>
                        <p style="margin: 5px 0; color: #aaa; font-size: 14px;">I.V.A.: $${ivaGeneral.toFixed(2)}</p>
                        <p style="margin: 10px 0; font-size: 24px; font-weight: bold;">Total: $${parseFloat(bookingData.totalPrice).toFixed(2)}</p>
                    </div>
                    <div style="text-align: center; margin-top: 40px; margin-bottom: 20px;">
                        <a href="${config.webUrl}" style="background-color: #fff; color: #000; padding: 12px 25px; text-decoration: none; font-weight: bold; border-radius: 50px;">Volver a la Web</a>
                    </div>
                    <div style="margin-top: 40px; border-top: 1px solid #333; padding-top: 20px; text-align: center; color: #666; font-size: 12px;">
                        <p>${config.companyName}</p>
                        <p>${config.phone} | ${config.contactEmail}</p>
                    </div>
                </div>
            </div>
        `;

        // --- D. PLANTILLA ADMIN (Datos completos + Link Admin) ---
        const adminHtml = `
            <div style="font-family: sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f4f4f4; padding: 15px; border-bottom: 1px solid #ddd;">
                    <h3 style="margin: 0; color: #000;">🔔 Nueva Reserva: ${bookingData.id}</h3>
                </div>
                <div style="padding: 20px;">
                    <div style="background-color: #eef; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
                        <h4 style="margin-top: 0; color: #337;">👤 Información del Cliente</h4>
                        <ul style="list-style: none; padding: 0; margin: 0; font-size: 14px;">
                            <li style="margin-bottom: 5px;"><strong>Nombre:</strong> ${bookingData.customerName}</li>
                            <li style="margin-bottom: 5px;"><strong>Cédula/ID:</strong> ${bookingData.customerCedula || 'N/A'}</li>
                            <li style="margin-bottom: 5px;"><strong>Email:</strong> <a href="mailto:${bookingData.customerEmail}">${bookingData.customerEmail}</a></li>
                            <li style="margin-bottom: 5px;"><strong>Teléfono:</strong> <a href="tel:${bookingData.customerPhone}">${bookingData.customerPhone}</a></li>
                            <li style="margin-bottom: 5px;"><strong>Dirección:</strong> ${bookingData.customerAddress || 'N/A'}</li>
                        </ul>
                    </div>
                    <h4 style="border-bottom: 2px solid #333; padding-bottom: 5px;">📋 Equipos Solicitados</h4>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
                        <thead>
                            <tr style="background-color: #f9f9f9; text-align: left;">
                                <th style="padding: 8px; border-bottom: 2px solid #ddd;">Img</th>
                                <th style="padding: 8px; border-bottom: 2px solid #ddd;">Equipo / Fechas</th>
                                <th style="padding: 8px; border-bottom: 2px solid #ddd; text-align: right;">Total</th>
                            </tr>
                        </thead>
                        <tbody>${rowsAdmin}</tbody>
                        <tfoot>
                            <tr>
                                <td colspan="2" style="padding: 10px; text-align: right; font-weight: bold;">Total Reserva:</td>
                                <td style="padding: 10px; text-align: right; font-weight: bold; font-size: 16px;">$${parseFloat(bookingData.totalPrice).toFixed(2)}</td>
                            </tr>
                        </tfoot>
                    </table>
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${config.adminUrl}" style="background-color: #000; color: #fff; padding: 15px 30px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">Ir al Centro de Mando</a>
                        <p style="font-size: 11px; color: #999; margin-top: 10px;">(Requiere inicio de sesión)</p>
                    </div>
                </div>
            </div>
        `;

        // E. ENVIAR
        await transporter.sendMail({
            from: `"${config.companyName}" <${process.env.SMTP_USER}>`,
            to: bookingData.customerEmail,
            subject: `Solicitud Recibida #${bookingData.id} - ${config.companyName}`,
            html: clientHtml,
            replyTo: config.adminEmail
        });

        await transporter.sendMail({
            from: `"Web System" <${process.env.SMTP_USER}>`,
            to: config.adminEmail,
            subject: `🔔 Nueva Reserva: ${bookingData.customerName} ($${parseFloat(bookingData.totalPrice).toFixed(2)})`,
            html: adminHtml
        });

        console.log(`✅ Correos PRO enviados: ${bookingData.id}`);

    } catch (e) {
        console.error("❌ Error enviando correos:", e);
    }
}


// --- 3. HANDLER PRINCIPAL ---
exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    let body;
    try { body = JSON.parse(event.body); if (typeof body === 'string') body = JSON.parse(body); } catch (e) { throw new Error('JSON inválido.'); }
    const operations = Array.isArray(body) ? body : [body];

    const hasAdminToken = await validateGoogleToken(event);
    let services;

    if (hasAdminToken) {
        services = await getServices();
    } else {
        const allowedPublicSheets = ['Bookings', 'BookingsDetails', 'BlockedDates'];
        const isSafePublicRequest = operations.every(op => op.action === 'add' && allowedPublicSheets.includes(op.sheet));
        if (!isSafePublicRequest) return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'No autorizado.' }) };
        services = await getServices(true);
    }

    const { doc, drive } = services;

    for (const op of operations) {
        if (op.action === 'delete_file_only' && op.data && op.data.fileId) {
            try { await drive.files.update({ fileId: op.data.fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch (e) {}
            op._processed = true; 
        }
    }

    const opsBySheet = {};
    operations.forEach(op => { if (!op._processed) { if (!opsBySheet[op.sheet]) opsBySheet[op.sheet] = []; opsBySheet[op.sheet].push(op); } });

    for (const sheetName of Object.keys(opsBySheet)) {
        const sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) continue;
        await sheet.loadHeaderRow();
        const sheetOps = opsBySheet[sheetName];
        
        if (sheetName === 'Bookings') {
            const bookingsToAdd = sheetOps.filter(op => op.action === 'add' || op.action === 'update');
            if (bookingsToAdd.length > 0) {
                const blockedSheet = doc.sheetsByTitle['BlockedDates'];
                if (blockedSheet) {
                    await blockedSheet.loadHeaderRow();
                    const blockedRows = await blockedSheet.getRows();
                    const hStart = getRealHeader(blockedSheet, 'startDate'); const hEnd = getRealHeader(blockedSheet, 'endDate'); const hItem = getRealHeader(blockedSheet, 'itemId'); const hBook = getRealHeader(blockedSheet, 'bookingId');
                    if(hStart && hEnd && hItem) {
                        const blocks = blockedRows.map(r => ({ start: new Date(r.get(hStart)), end: new Date(r.get(hEnd)), itemId: r.get(hItem), bookingId: hBook ? r.get(hBook) : null }));
                        for (const op of bookingsToAdd) {
                            if (op.data.status === 'Cancelado') continue;
                            const reqStart = new Date(op.data.startDate); const reqEnd = new Date(op.data.endDate);
                            const conflict = blocks.find(b => {
                                if (b.itemId !== op.data.itemId) return false;
                                if (op.criteria && b.bookingId === op.criteria.id) return false;
                                return reqStart <= b.end && reqEnd >= b.start;
                            });
                            if (conflict) throw new Error(`CONFLICTO: Equipo ya reservado.`);
                        }
                    }
                }
            }
        }

        const adds = sheetOps.filter(op => op.action === 'add');
        const updates = sheetOps.filter(op => op.action === 'update');
        const deletes = sheetOps.filter(op => op.action === 'delete');

        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) { op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`; }
            const rowData = {};
            Object.keys(op.data).forEach(k => { const h = getRealHeader(sheet, k); if (h) rowData[h] = op.data[k]; });
            await sheet.addRow(rowData); 
            
            // ENVÍO DE CORREO
            if (sheetName === 'Bookings' && !hasAdminToken) {
                await sendReservationEmails(doc, op.data, operations);
            }
        }
        
        // El resto de updates/deletes (código Drive, renombrar carpetas, etc.) se mantiene intacto.
        if (updates.length > 0) {
            const rows = await sheet.getRows(); 
            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0]; const criteriaVal = String(op.criteria[criteriaKey]).trim(); const realHeaderKey = getRealHeader(sheet, criteriaKey); if (!realHeaderKey && ['Settings', 'About'].includes(sheetName)) { await sheet.addRow({ ...op.criteria, ...op.data }); continue; } const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);
                if (targetRow) {
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) { const titleKey = sheetName === 'RentalItems' ? 'name' : 'title'; const newTitle = getDataVal(op.data, titleKey); if (newTitle) { const hTitle = getRealHeader(sheet, titleKey); const hFolder = getRealHeader(sheet, 'driveFolderId'); const currentTitle = hTitle ? targetRow.get(hTitle) : ''; const folderId = hFolder ? targetRow.get(hFolder) : null; if (folderId && currentTitle !== newTitle) { try { await drive.files.update({ fileId: folderId, requestBody: { name: newTitle }, supportsAllDrives: true }); } catch(e){} } } }
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') { const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId'; const pHeader = getRealHeader(sheet, pKey); const cHeader = getRealHeader(sheet, 'isCover'); if (pHeader && cHeader) { const currentPId = targetRow.get(pHeader); for (const r of rows) { if (r !== targetRow && String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') { r.set(cHeader, 'No'); await r.save(); } } } }
                    let hasChanges = false; Object.keys(op.data).forEach(key => { const h = getRealHeader(sheet, key); if (h) { targetRow.set(h, op.data[key]); hasChanges = true; } }); if (hasChanges) await targetRow.save();
                }
            }
        }
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); for (const op of deletes) { const criteriaKey = Object.keys(op.criteria)[0]; const criteriaVal = String(op.criteria[criteriaKey]).trim(); const realKeyHeader = getRealHeader(sheet, criteriaKey); if (!realKeyHeader) continue; if (sheetName === 'RentalCategories') { /*Validation*/ } const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal); if (row) { let fileId = getDataVal(op.data, 'fileId'); if (!fileId) { const hFile = getRealHeader(sheet, 'fileId'); if (hFile) fileId = row.get(hFile); } if (fileId) { try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} } if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) { const hFolder = getRealHeader(sheet, 'driveFolderId'); const folderId = hFolder ? row.get(hFolder) : null; if (folderId) { try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} } if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal); if (sheetName === 'RentalItems') { await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal); await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal); await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal); } if (sheetName === 'Services') { await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal); await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal); } } await row.delete(); } }
        }
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'OK' }) };
  } catch (error) { console.error('Error:', error); return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) }; }
};
