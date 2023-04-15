const
  {inspect} = require("node:util"), log = console.log.bind(console), dir = value => log(inspect(value, false, 16, true), "\n"),
  {Address} = require("ton-core"), {HttpApi} = require("ton"), api = new HttpApi(require("./package.json").config.endpoint),
  types = require("staker-ton/types"), {fromHttpTx} = require("staker-ton"),
  {MongoClient} = require("mongodb"), mongo = new MongoClient("mongodb://localhost/", {useNewUrlParser: true, useUnifiedTopology: true}),
  main = async () => {
    await mongo.connect()
    let
      limit = 512,
      target = Address.parse(process.argv[2]),
      address = await api.getAddressInformation(target),
      cursor = address.last_transaction_id,
      db = mongo.db("staker")

    while (cursor) {
      let
        batch, tx
      try {
        batch = await api.getTransactions(target, {limit, lt: cursor.lt, hash: cursor.hash, inclusive: false})
      } catch (error) {
        log("getTransactions error", error.message)
        await new Promise(resolve => setTimeout(resolve, 1000))
        continue
      }
      for (tx of batch) {
        const transaction = fromHttpTx(tx), raw = types.Transaction.encode(transaction)
        await db.collection("transaction").updateOne(
          {id: transaction.id},
          {$set: raw},
          {upsert: true}
        )
      }
      cursor = tx?.transaction_id
      log(new Date(), batch.length, "items loaded, last time is", tx?.utime)
    }
    log("done.")
    process.exit(0)
  }

main().catch(error => {
  dir(error)
})