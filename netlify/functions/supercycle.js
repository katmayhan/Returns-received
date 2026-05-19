const SUPERCYCLE_API_KEY = '9cxAk2V1hmaPBmKCGq59XCUfUxv1XW';
const BASE_URL = 'https://app.supercycle.com/api/v1';

const scFetch = (url, options = {}) => fetch(url, {
  ...options,
  headers: {
    'Authorization': `Bearer ${SUPERCYCLE_API_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
});

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  try {
    const { action, payload } = JSON.parse(event.body);

    // ── Get rentals ──
    if (action === 'getRentals') {
      const url = payload.shopifyOrderId
        ? `${BASE_URL}/rentals?shopifyOrderId=${payload.shopifyOrderId}&excludeCancelled=true`
        : `${BASE_URL}/rentals?search=${encodeURIComponent(payload.orderName)}&excludeCancelled=true`;
      const res = await scFetch(url);
      const data = await res.json();
      return { statusCode: res.status, headers: cors, body: JSON.stringify(data) };
    }

    // ── Create or update return, then mark lines as received ──
    if (action === 'createReturn') {
      const { rentalId } = payload;

      // First check if a return order already exists for this rental
      const rentalRes = await scFetch(`${BASE_URL}/rentals/${rentalId}`);
      const rentalData = await rentalRes.json();
      console.log('rental:', JSON.stringify(rentalData));

      let returnOrderId = rentalData.returnOrderId || null;
      let returnLines = [];

      if (returnOrderId) {
        // Return order already exists — fetch its lines
        const roRes = await scFetch(`${BASE_URL}/return_orders/${returnOrderId}`);
        const roData = await roRes.json();
        console.log('existing return order:', JSON.stringify(roData));
        returnLines = roData.returnLines || [];
      } else {
        // Create a new return order
        const createRes = await scFetch(`${BASE_URL}/return_orders`, {
          method: 'POST',
          body: JSON.stringify({ data: [{ rentalId }] })
        });
        const createData = await createRes.json();
        console.log('created return order:', JSON.stringify(createData));
        const returnOrder = createData.returnOrders && createData.returnOrders[0];
        if (!returnOrder) {
          return { statusCode: 422, headers: cors, body: JSON.stringify({ error: 'Failed to create return', detail: createData }) };
        }
        returnOrderId = returnOrder.id;
        returnLines = returnOrder.returnLines || [];
      }

      if (returnLines.length === 0) {
        return { statusCode: 422, headers: cors, body: JSON.stringify({ error: 'No return lines found', returnOrderId }) };
      }

      // Mark all return lines as received
      const updateRes = await scFetch(`${BASE_URL}/return_orders/${returnOrderId}`, {
        method: 'PUT',
        body: JSON.stringify({
          returnLines: returnLines.map(l => ({ id: l.id, status: 'received' }))
        })
      });
      const updateData = await updateRes.json();
      console.log('update result:', JSON.stringify(updateData));
      return { statusCode: updateRes.status, headers: cors, body: JSON.stringify(updateData) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('Error:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
