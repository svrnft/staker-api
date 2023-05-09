const
  path = require("path"), fs = require("fs"), {inspect} = require("node:util"), {config} = require("./package.json"),
  log = console.log.bind(console), dir = value => log(inspect(value, false, 16, true), "\n"),
  lodash = require("lodash"), logger = require("morgan"),
  {MongoClient} = require("mongodb"),
  express = require("express"), bodyParser = require("body-parser"), cookieParser = require("cookie-parser"), cors = require("cors"),
  Agenda = require("agenda"), Agendash = require("agendash"),
  {Address, Cell, beginCell, fromNano} = require("ton-core"), {TonClient, HttpApi} = require("ton"),
  {fromHttpTx} = require("staker-ton"),
  {Member, Pool, Transaction} = require("staker-ton/types"),
  yaml = require("yaml"), SwaggerUi = require("swagger-ui-express")

let
  app = express(),
  mongo = new MongoClient("mongodb://127.0.0.1/", {useNewUrlParser: true, useUnifiedTopology: true}),
  agenda = new Agenda({
    name: "pools",
    defaultConcurrency: 1,
    maxConcurrency: 1,
    ensureIndex: true,
    db: {address: "mongodb://127.0.0.1/staker", collection: "tasks"}
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
    let
      api = new HttpApi(config.endpoint),
      tx = await api.getTransactions(pool.address, {limit: 512}),
      known = await collection("transaction").find({id: {$in: tx.map(_ => _.transaction_id.hash)}}, {projection: {id: 1}}).toArray(),
      unknown = lodash.differenceWith(tx, known, (_, __) => _.transaction_id.hash === __.id)
    for (let tx of unknown) {
      const transaction = fromHttpTx(tx)
      await collection("transaction").insertOne(Transaction.encode(transaction))
    }
  },
  getParams = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    let
      client = new TonClient({endpoint: config.endpoint}),
      params = await client.runMethod(pool.address, "get_params")
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
  },
  getStakingStatus = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    let
      client = new TonClient({endpoint: config.endpoint}),
      status = await client.runMethod(pool.address, "get_staking_status")
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
  },
  getPoolStatus = async ({attrs: {data}}) => {
    let
      pool = Pool.decode(data).right
    let
      client = new TonClient({endpoint: config.endpoint}),
      balance = await client.runMethod(pool.address, "get_pool_status")
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
  }

app
  .use(bodyParser.urlencoded({extended: true})).use(bodyParser.json()).use(cookieParser()).use(logger("dev")).use(cors())
  .use("/", express.static(path.resolve("../staker-app/dist")))
  .use("/agenda", Agendash(agenda))
  .use("/doc", SwaggerUi.serve, SwaggerUi.setup(yaml.parse(fs.readFileSync("./openapi.yml").toString()), {
    swaggerOptions: {
      displayOperationId: false,
      defaultModelsExpandDepth: 3,
      defaultModelExpandDepth: 3,
      defaultModelRendering: "model",
      docExpansion: "full",
      filter: false,
      tryItOutEnabled: true
    },
    customCssUrl: ["./swagger.css"]
  }))
  .get(["/e", "/e/:pool", "/e/m/:pool"], async (req, res) => res.sendFile(path.resolve("../staker-app/dist/index.html")))

app.get("/api/member/:pool/:address", async (req, res) => {
  const
    poolAddress = Address.from(req.params.pool),
    memberAddress = Address.from(req.params.address)
  if (! poolAddress || (! memberAddress)) return res.sendStatus(404)
  const
    pool = await collection("pool").findOne({address: poolAddress.toRawString()})
  if (! pool) return res.sendStatus(404)
  let
    client = new TonClient({endpoint: config.endpoint}),
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

app.get("/api/pools/:member", async (req, res) => {
  let
    client = new TonClient({endpoint: config.endpoint}),
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
        ret = await client.runMethod(
          Address.from(pool.address),
          "get_member",
          [{type: "slice", cell: beginCell().storeAddress(memberAddress).asCell()}]
        )
      }
      catch (error) {
        log("get_member", error.message)
        await new Promise(resolve => setTimeout(resolve, 500))
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

process.on("SIGTERM", stop)
process.on("SIGINT", stop)

start()
