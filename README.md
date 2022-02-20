# ethdenver2022-teachable-ai-nft-functions (Harmony Testnet)

Firebase functions for Teachable AINFT on Harmony Testnet.

### Requirements
You need to set the function configs before deploying the functions.
```
firebase functions:config:set blockchain.provider_url_ainft=<AIN_BLOCKCHAIN_ENDPOINT>
firebase functions:config:set slack.teachable_ainft_monitoring_webhook_url=<SLACK_WEBHOOK_URL>
firebase functions:config:set storage_bucket.keystore_url=<AINFT_ADMIN_KEYSTORE_STORAGE_BUCKET>
firebase functions:config:set ain.ainft_keystore_password=<AINFT_ADMIN_KEYSTORE_PASSWORD>
```

### Deploy
```
firebase deploy --only functions
```
