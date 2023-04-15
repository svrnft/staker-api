const
  log = console.log.bind(console),
  {inspect} = require("node:util"),
  dir = value => log(inspect(value, false, 16, true), "\n"), sleep = async ms => new Promise(resolve => setTimeout(resolve, ms)),
  path = require("path"),
  lodash = require("lodash"),
  {MongoClient} = require("mongodb"),
  express = require("express"),
  bodyParser = require("body-parser"),
  cookieParser = require("cookie-parser"),
  logger = require("morgan"),
  cors = require("cors"),
  Agenda = require("agenda"), Agendash = require("agendash"),
  {Address, Cell, beginCell, fromNano} = require("ton-core"),
  {TonClient, HttpApi} = require("ton"),
  {stake, withdraw, fromHttpTx, fromHttp} = require("staker-ton"),
  {Member, Pool, Transaction} = require("staker-ton/types")
  
let
  app = express(),
  mongo = new MongoClient("mongodb://localhost/staker", {useNewUrlParser: true, useUnifiedTopology: true}),
  agenda = new Agenda({
    name: "pools",
    defaultConcurrency: 1,
    maxConcurrency: 1,
    ensureIndex: true,
    db: {address: "mongodb://localhost/staker", collection: "tasks"}
  }), db, collection = name => db.collection(name),
  start = async () => {
    db = (await mongo.connect()).db("staker")
    // try { await collection("tasks").drop() } catch {}
    await agenda.start()
    for (let pool of await collection("pool").find({active: true}).toArray()) {
      // await getTransactions({attrs: {data: pool}})
      // await getParams({attrs: {data: pool}})
      // await getStakingStatus({attrs: {data: pool}})
      // await getPoolStatus({attrs: {data: pool}})

      agenda.define(`get-transactions-${pool.address}`, getTransactions)
      agenda.define(`get-params-${pool.address}`, getParams)
      agenda.define(`get-staking-status-${pool.address}`, getStakingStatus)
      agenda.define(`get-pool-status-${pool.address}`, getPoolStatus)

      agenda.every("5 minutes", `get-transactions-${pool.address}`, pool)
      agenda.every("10 minutes", `get-params-${pool.address}`, pool)
      agenda.every("10 minutes", `get-staking-status-${pool.address}`, pool)
      agenda.every("10 minutes", `get-pool-status-${pool.address}`, pool)

    }
    log((await app.listen(2022)).address())
  },
  stop = async () => {
    await agenda.stop()
    await mongo.close()
    log("bye.")
    process.exit(0)
  },
  getTransactions = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    console.time(`get-transactions(${pool.address.toShortString()})`)
    let
      api = new HttpApi("https://mainnet.tonhubapi.com/jsonRPC"),
      tx = await api.getTransactions(pool.address, {limit: 512}),
      known = await collection("transaction").find({id: {$in: tx.map(_ => _.transaction_id.hash)}}, {projection: {id: 1}}).toArray(),
      unknown = lodash.differenceWith(tx, known, (_, __) => _.transaction_id.hash === __.id)
    for (let tx of unknown) {
      const transaction = fromHttpTx(tx)
      await collection("transaction").insertOne(Transaction.encode(transaction))
    }
    // log("known", known.length, "unknown", unknown.length)
    console.timeEnd(`get-transactions(${pool.address.toShortString()})`)
  },
  getParams = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    console.time(`get-params(${pool.address.toShortString()})`)
    let
      client = new TonClient({endpoint: "https://mainnet.tonhubapi.com/jsonRPC"}),
      params = await client.callGetMethod(pool.address, "get_params")
    await collection("pool").updateOne({address: pool.address.toRawString()}, {
      $set: {
        params: {
          enabled: params.stack.readBigNumber() === -1n,
          updatesEnabled: params.stack.readBigNumber() === -1n,
          minStake: params.stack.readBigNumber().toString(),
          depositFee: params.stack.readBigNumber().toString(),
          withdrawFee: params.stack.readBigNumber().toString(),
          poolFee: params.stack.readBigNumber().toString(),
          receiptPrice: params.stack.readBigNumber().toString(),
        }
      }
    })
    console.timeEnd(`get-params(${pool.address.toShortString()})`)
  },
  getStakingStatus = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    console.time(`get-staking-status(${pool.address.toShortString()})`)
    let
      client = new TonClient({endpoint: "https://mainnet.tonhubapi.com/jsonRPC"}),
      status = await client.callGetMethod(pool.address, "get_staking_status")
    await collection("pool").updateOne({address: pool.address.toRawString()}, {
      $set: {
        status: {
          proxyStakeAt: parseInt(status.stack.readBigNumber().toString()),
          proxyStakeUntil: parseInt(status.stack.readBigNumber().toString()),
          proxyStakeSent: status.stack.readBigNumber().toString(),
          querySent: status.stack.readBigNumber() === 1n,
          unlocked: status.stack.readBigNumber() === 1n,
          ctxLocked: status.stack.readBigNumber() === 1n,
        }
      }
    })
    console.timeEnd(`get-staking-status(${pool.address.toShortString()})`)
  },
  getPoolStatus = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    console.time(`get-pool-status(${pool.address.toShortString()})`)
    let
      client = new TonClient({endpoint: "https://mainnet.tonhubapi.com/jsonRPC"}),
      balance = await client.callGetMethod(pool.address, "get_pool_status")
    await collection("pool").updateOne({address: pool.address.toRawString()}, {
      $set: {
        balance: {
          value: balance.stack.readBigNumber().toString(),
          sent: balance.stack.readBigNumber().toString(),
          pendingDeposits: balance.stack.readBigNumber().toString(),
          pendingWithdraw: balance.stack.readBigNumber().toString(),
          withdraw: balance.stack.readBigNumber().toString()
        }
      }
    })
    console.timeEnd(`get-pool-status(${pool.address.toShortString()})`)
  }

app
  .use(bodyParser.urlencoded({extended: true}))
  .use(bodyParser.json())
  .use(cookieParser())
  .use(logger("dev"))
  .use(cors())
  .use("/", express.static(path.resolve(__dirname, "../staker-app/dist")))
  .use("/agenda", Agendash(agenda))

app.get("/api/member/:pool/:address", async (req, res) => {
  const
    poolAddress = Address.from(req.params.pool),
    memberAddress = Address.from(req.params.address)
  if (! poolAddress || (! memberAddress)) return res.sendStatus(404)
  const
    pool = await collection("pool").findOne({address: poolAddress.toRawString()})
  if (! pool) return res.sendStatus(404)
  let
    client = new TonClient({endpoint: "https://mainnet.tonhubapi.com/jsonRPC"}),
    {stack} = await client.callGetMethod(
      poolAddress,
      "get_member",
      [{type: "slice", cell: beginCell().storeAddress(memberAddress).asCell()}]
    ),
    member = {
      pool: poolAddress,
      address: memberAddress,
      balance: stack.readBigNumber(),
      pendingDeposit: stack.readBigNumber(),
      pendingWithdraw: stack.readBigNumber(),
      withdraw: stack.readBigNumber(),
    },
    actions = await mongo.db("staker").collection("transaction").find({
      $or: [
        {messages: {$elemMatch: {source: poolAddress.toRawString(), destination: memberAddress.toRawString(), "body.type": "deposit::ok"}}},
        {messages: {$elemMatch: {source: poolAddress.toRawString(), destination: memberAddress.toRawString(), "body.data": {$regex: /Stake \d+(\.\d+)? accepted/}}}},
        {messages: {$elemMatch: {source: poolAddress.toRawString(), destination: memberAddress.toRawString(), "body.type": "withdraw::ok"}}},
        {messages: {$elemMatch: {source: poolAddress.toRawString(), destination: memberAddress.toRawString(), "body.data": "Withdraw completed"}}}
      ]
    }).sort({time: 1}).toArray()
  res.json({member: Member.encode(member), actions, pool})
})

app.get("/api/pool/:address", async (req, res) => {
  const
    address = Address.from(req.params.address),
    pool = await mongo.db("staker").collection("pool").findOne({address: Address.from(req.params.address).toRawString()}),
    latest = await mongo.db("staker").collection("transaction").find({
      $or: [
        {messages: {$elemMatch: {source: address.toRawString(), "body.type": "deposit::ok"}}},
        {messages: {$elemMatch: {source: address.toRawString(), "body.data": {$regex: /Stake \d+(\.\d+)? accepted/}}}},
        {messages: {$elemMatch: {source: address.toRawString(), "body.type": "withdraw::ok"}}},
        {messages: {$elemMatch: {source: address.toRawString(), "body.data": "Withdraw completed"}}}
      ]
    }).limit(10).toArray()
  res.json({...pool, latest: lodash.uniqBy(latest, "messages[1].destination")})
})

app.get("/api/pool", async (req, res) => {
  res.json(await mongo.db("staker").collection("pool").find({}).toArray())
})

app.get("/api/e/pool/:member", async (req, res) => {
  let
    client = new TonClient({endpoint: "https://mainnet.tonhubapi.com/jsonRPC"}),
    memberAddress = Address.from(req.params.member),
    actions = lodash.groupBy(await mongo.db("staker").collection("transaction").find({
      $or: [
        {messages: {$elemMatch: {destination: memberAddress.toRawString(), "body.type": "deposit::ok"}}},
        {messages: {$elemMatch: {destination: memberAddress.toRawString(), "body.data": {$regex: /Stake \d+(\.\d+)? accepted/}}}},
        {messages: {$elemMatch: {destination: memberAddress.toRawString(), "body.type": "withdraw::ok"}}},
        {messages: {$elemMatch: {destination: memberAddress.toRawString(), "body.data": "Withdraw completed"}}}
      ]
    }).sort({time: 1}).toArray(), "messages[1].source"),
    pools = await mongo.db("staker").collection("pool").find({}).toArray()

  for (let pool of pools) {
    pool.actions = lodash.get(actions, pool.address, [])
    let ret
    while (! ret) {
      try {
        ret = await client.callGetMethod(
          Address.from(pool.address),
          "get_member",
          [{type: "slice", cell: beginCell().storeAddress(memberAddress).asCell()}]
        )
      }
      catch (error) {
        log("get_member", error.message)
        await sleep(500)
      }
    }
    pool.member = Member.encode({
      pool: Address.from(pool.address),
      address: memberAddress,
      balance: ret.stack.readBigNumber(),
      pendingDeposit: ret.stack.readBigNumber(),
      pendingWithdraw: ret.stack.readBigNumber(),
      withdraw: ret.stack.readBigNumber(),
    })
  }
  res.json(pools)
})

app.get("/e", async (req, res) => res.sendFile(path.resolve("../staker-app/dist/index.html")))
app.get("/e/:pool", async (req, res) => res.sendFile(path.resolve("../staker-app/dist/index.html")))
app.get("/e/m/:pool", async (req, res) => res.sendFile(path.resolve("../staker-app/dist/index.html")))

process.on("SIGTERM", stop)
process.on("SIGINT", stop)

start()
