const SUPERCYCLE_API_KEY = '9cxAk2V1hmaPBmKCGq59XCUfUxv1XW';
const BASE_URL = 'https://app.supercycle.com/api/v1';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { action, payload } = JSON.parse(event.body);

    let url, method, body;

    if (action === 'getRentals') {
      // GET /rentals?shopifyOrderId=X
      if (payload.shopifyOrderId) {
      url = `${BASE_URL}/rentals?shopifyOrderId=${payload.shopifyOrderId}&excludeCancelled=true`;
    } else {
      url = `${BASE_URL}/rentals?search=${encodeURIComponent(payload.orderName)}&excludeCancelled=true`;
    }
      method = 'GET';

    } else if (action === 'createReturn') {
      // POST /return_orders then immediately PUT to mark as received
      const createRes = await fetch(`${BASE_URL}/return_orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPERCYCLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          data: [{ rentalId: payload.rentalId, status: 'awaiting' }]
        })
      });
      const createData = await createRes.json();
      const returnOrder = createData.returnOrders && createData.returnOrders[0];
      if (!returnOrder) {
        return { statusCode: 422, headers, body: JSON.stringify({ error: 'Failed to create return', detail: createData }) };
      }
      // Now mark as received — update both the order status and each return line
      const returnLineIds = returnOrder.returnLines ? returnOrder.returnLines.map(l => l.id) : [];
      const updateRes = await fetch(`${BASE_URL}/return_orders/${returnOrder.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${SUPERCYCLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: 'received',
          returnLines: returnLineIds.map(id => ({ id, status: 'received' }))
        })
      });
      const updateData = await updateRes.json();
      return { statusCode: updateRes.status, headers, body: JSON.stringify(updateData) };

    } else if (action === 'updateReturn') {
      // PUT /return_orders/{id} — mark as received
      url = `${BASE_URL}/return_orders/${payload.returnOrderId}`;
      method = 'PUT';
      body = JSON.stringify({
        status: 'received',
        returnLines: payload.returnLineIds.map(id => ({ id, status: 'received' }))
      });

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${SUPERCYCLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      ...(body ? { body } : {})
    });

    const data = await response.json();
    return { statusCode: response.status, headers, body: JSON.stringify(data) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
