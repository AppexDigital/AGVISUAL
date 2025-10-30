// functions/update-sheet-data.js
// v2.0 - Actualizado a Google OAuth
// API genérica protegida para Crear, Actualizar y Borrar (CRUD) datos.

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
// Importamos nuestro NUEVO verificador de autorización
const { validateGoogleToken } = require('./google-auth-helper');

// --- Helpers (Sin cambios) ---
async function getDoc() {
  // Esta función SIGUE USANDO LA CUENTA DE SERVICIO (ROBOT)
  // para leer/escribir en la hoja.
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

// Helper para encontrar una fila por criterios
async function findRow(sheet, criteria) {
  if (!criteria || Object.keys(criteria).length === 0) {
    throw new Error("Criteria (criterio de búsqueda) es requerido para esta acción.");
  }
  await sheet.loadHeaderRow(); // Asegurar encabezados
  const rows = await sheet.getRows();
  const key = Object.keys(criteria)[0];
  const value = String(criteria[key]); // Comparar como strings
  return rows.find(row => String(row.get(key)) === value);
}

// Helper para encontrar MÚLTIPLES filas por criterios
async function findRows(sheet, criteria) {
  if (!criteria || Object.keys(criteria).length === 0) {
    return []; // No hay criterio, no se devuelve nada
  }
  await sheet.loadHeaderRow(); // Asegurar encabezados
  const rows = await sheet.getRows();
  const key = Object.keys(criteria)[0];
  const value = String(criteria[key]); // Comparar como strings
  return rows.filter(row => String(row.get(key)) === value);
}

// --- Handler Principal (Actualizado) ---
exports.handler = async (event, context) => {
  // 1. **SEGURIDAD (Actualizado):** Verificar el token de Google del usuario.
  if (!(await validateGoogleToken(event))) {
    return {
      statusCode: 401, // No autorizado
      body: JSON.stringify({ error: 'No autorizado. Token de Google inválido o expirado.' }),
    };
  }
  // Si llegamos aquí, el usuario está autenticado.

  // 2. Método HTTP: Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let doc;
  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);

    // 3. Validación básica
    if (!sheetTitle || !action) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parámetros: se requiere "sheet" y "action".' }) };
    }
    if ((action === 'update' || action === 'delete') && !criteria) {
      return { statusCode: 400, body: JSON.stringify({ error: `La acción "${action}" requiere "criteria".` }) };
    }
    if (action === 'add' && !data) {
      return { statusCode: 400, body: JSON.stringify({ error: 'La acción "add" requiere "data".' }) };
    }

    doc = await getDoc();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) {
      return { statusCode: 404, body: JSON.stringify({ error: `Hoja "${sheetTitle}" no encontrada.` }) };
    }
    
    await sheet.loadHeaderRow(); // Cargar encabezados antes de operar

    // 4. Lógica de Acciones (CRUD)
    switch (action.toLowerCase()) {
      case 'add': {
        // Generar un ID simple si no se proporciona en data
        if (!data.id) {
            data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        }

        // Lógica Especial (Portadas v1.2)
        if (sheetTitle === 'ProjectImages' && data.isCover && data.isCover.toLowerCase() === 'si') {
          const projectImages = await findRows(sheet, { projectId: data.projectId });
          for (const imgRow of projectImages) {
            if (imgRow.get('isCover') && imgRow.get('isCover').toLowerCase() === 'si') {
              imgRow.set('isCover', 'No'); // Poner el 'No' como string
              await imgRow.save();
            }
          }
        }

        const newRow = await sheet.addRow(data);
        return { 
          statusCode: 200, 
          body: JSON.stringify({ message: 'Registro añadido con éxito.', newId: data.id, newRowData: newRow.toObject() }) 
        };
      }

      case 'update': {
        const rowToUpdate = await findRow(sheet, criteria);
        if (!rowToUpdate) {
          return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado para actualizar.', criteria }) };
        }

        // Lógica Especial (Portadas v1.2)
        if (sheetTitle === 'ProjectImages' && data.isCover && data.isCover.toLowerCase() === 'si') {
          const projectImages = await findRows(sheet, { projectId: rowToUpdate.get('projectId') });
          for (const imgRow of projectImages) {
            // Desmarca cualquier otra fila que sea portada
            if (imgRow.get('isCover') && imgRow.get('isCover').toLowerCase() === 'si' && imgRow.get('id') !== rowToUpdate.get('id')) {
              imgRow.set('isCover', 'No');
              await imgRow.save();
            }
          }
        }

        // Actualizar solo los campos proporcionados en 'data'
        const headers = sheet.headerValues || [];
        Object.keys(data).forEach(key => {
          if (headers.includes(key)) {
            rowToUpdate.set(key, data[key]);
          }
        });
        await rowToUpdate.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'Registro actualizado con éxito.', updatedData: rowToUpdate.toObject() }) };
      }

      case 'delete': {
        const rowToDelete = await findRow(sheet, criteria);
        if (!rowToDelete) {
          return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado para eliminar.', criteria }) };
        }
        await rowToDelete.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'Registro eliminado con éxito.' }) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: `Acción "${action}" no reconocida.` }) };
    }

  } catch (error) {
    console.error('Error en update-sheet-data:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno del servidor al procesar la solicitud.', details: error.message }),
    };
  }
};

