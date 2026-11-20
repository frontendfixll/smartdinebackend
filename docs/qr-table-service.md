# QR table service pilot

Deploy this API before the companion restaurant frontend. MongoDB must support transactions. Staff use **Tables & service** to seat a walk-in or confirm a QR arrival. Booked parties use the existing reservation check-in. A scan or an arrival request does not occupy a table. The host confirms the cover count once.

## Enable one section

Set `QR_SERVICE_ZONES` to an existing section name such as `Terrace`. Comma-separated names are supported. A blank value keeps new visits on the existing workflow. With `QR_SERVICE_MODE=shadow`, seating saves a suggested waiter on the session and keeps the host's choice. With `QR_SERVICE_MODE=live`, the same sections use guest codes and automatic assignment. Restart API and worker processes together after changing these settings. Flag changes apply on the next visit. Existing visits retain their policy through moves and turnover.

In production, the application disables automatic index creation. Before enabling a zone, run this from the built backend with the target environment configured. It creates the declared indexes on the three pilot collections and preserves existing indexes.

```sh
node -e "require('./dist/app'); const m=require('mongoose'); const {connectDatabase}=require('./dist/db/connect'); (async()=>{await connectDatabase(); for(const name of ['TableSession','VisitServiceTask','TableServiceNotice']) await m.model(name).createIndexes()})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>m.disconnect())"
```

Clock in at least one active waiter. A manager can set the section, capacity and overflow permission under **Waiter shift coverage**. Initial limits are five tables and sixteen covers per waiter. A break stops new assignments. The floor inbox flags existing tables that need cover. An accepted handover transfers responsibility. A manager can record a reason and transfer immediately. Shift settings last for that shift.

## Run a service check

1. Scan the same QR on two phones. The table remains vacant while the host reviews arrival requests.
2. Seat four guests. Check the waiter and four covers in the 3D floor details. Share the eight-character code shown in the staff panel.
3. Join on both phones and request water. Acknowledge and complete the request on the floor. Check the result on both phones.
4. Place an order. Mark an item ready in the kitchen. Pick it up at the service pass and confirm delivery. Other items can keep cooking.
5. Settle all orders, confirm departure, then mark the table clean. A prior phone needs a new code for the next party.

Codes rotate every fifteen minutes with one previous interval accepted. Each join yields a distinct four-hour grant. Closing the visit revokes ordering and service access immediately. Staff can take assisted orders for guests without phones. The existing payment flow still controls settlement.

The floor reads the persisted queue every ten seconds. Agenda also publishes committed service events and retries notification failures. Device push requires the existing VAPID setup and a subscribed staff device. A published notification and a staff acknowledgement are separate records.

## Automated integration check

Run `npm run build`, then run the following with a local MongoDB replica set. The test creates and drops a uniquely named test database. It exercises real HTTP routes and transactions.

```sh
QR_TEST_MONGO='mongodb://127.0.0.1:27017/?replicaSet=rs0' node tests/tableService.integration.cjs
```

During the restaurant pilot, review duplicate visits, unanswered requests, greeting times, and covers per waiter with the shift lead. The initial greeting alert is ninety seconds. Tune the limits against observed service times before expanding enrollment.
