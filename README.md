# $TAKER API Deploy Notes

### Requirements:

- Nodejs 19+ (using NVM)
- MongoDB 6.0 Community

### MongoDB

Please use latest MongoDB Community edition instead of outdated default packages:

https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-red-hat/

```
$ mongod --version
db version v6.0.3
Build Info: {
    "version": "6.0.3",
    "gitVersion": "f803681c3ae19817d31958965850193de067c516",
    "openSSLVersion": "OpenSSL 1.1.1f  31 Mar 2020",
    "modules": [],
    "allocator": "tcmalloc",
    "environment": {
        "distmod": "ubuntu2004",
        "distarch": "x86_64",
        "target_arch": "x86_64"
    }
}
```

### NVM & NodeJS

To manage NodeJS please use NVM instead of outdated default packages:

https://github.com/nvm-sh/nvm#installing-and-updating

After NVM installed just run

```
$ nvm ls-remote
$ nvm install node
$ nvm use node
$ node --version
v20.1.0
```

To switch to at least 19.0

### Database

Download fresh version of DB dump from

https://staker.ton.shiksha/dump.gz

You need this once to start and continiously running from current point. Restore database with

```
$ wget https://staker.ton.shiksha/dump.gz
$ mongorestore --db staker dump.gz
```

### API Service

Checkout `staker-api` repo to projects folder (~ by default) and run it (as a service or in terminal multiplexor):

```
$ git clone https://github.com/tonshebang/staker-api.git
$ cd staker-api
$ npm install
$ node app.js
```

THATS IT. How to run nvm managed NodeJS scripts as a SystemV service please checkout notes:

https://gist.github.com/joepie91/73ce30dd258296bd24af23e9c5f761aa

### Healthckeck route

https://your-api-instance/api/health

Will respond with `200 OK` and JSON `{"ok": 1}` while API service is running

#### Feedback and Support

Feel free to ask anything from

https://t.me/commonbabylightmyfire