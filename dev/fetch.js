const fetch = require('node-fetch');
fetch("http://192.168.124.6:3000/api/routes/strava-segments?bounds=31.033667074298013,121.3103485107422,31.170656703346687,121.38416290283205&zoom=13", {
    "headers": {
        "accept": "*/*",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "Referer": "http://localhost:8080/"
    },
    "body": null,
    "method": "GET"
});