const admin = require('firebase-admin');
const functions = require('firebase-functions');
const logger = require("firebase-functions/lib/logger");
const { Storage } = require('@google-cloud/storage');
const Ain = require('@ainblockchain/ain-js').default;
const Web3 = require('web3');
const _ = require('lodash');
const { sleep } = require('sleep');
const express = require('express');
const { IncomingWebhook } = require('@slack/webhook');
const {
  TEACHABLE_AINFT_ERC721_MINT_EVENT_TYPE_ARR,
  TEACHABLE_AINFT_ERC721_MINT_EVENT_TOPIC,
  isProd,
} = require('./constants');
const storage = new Storage();
const harmonyProviderUrl = 'https://api.s0.b.hmny.io';
const ainProviderUrl = _.get(functions.config(), 'blockchain.provider_url_ainft');
const teachableAinftMonitoringWebhookUrl = _.get(functions.config(),
    'slack.teachable_ainft_monitoring_webhook_url');
const webhook = teachableAinftMonitoringWebhookUrl ?
    new IncomingWebhook(teachableAinftMonitoringWebhookUrl) : undefined;

const app = express();

function removeProtocolFromUrl(url) {
  if (!_.isString(url)) return '';
  return url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '');
}

function formatDescription(data, model, service, state) {
  return `# data\n${data}\n\n` +
      `# model\n` +
          `- name: ${model.name}\n` +
          (model.epoch === undefined ? '' : `- epoch: ${model.epoch}\n`) +
          `- platform: [${removeProtocolFromUrl(model.platform)}](${model.platform})\n\n` +
      `# service\n` +
          `- api: [${removeProtocolFromUrl(service.api)}](${service.api})\n` +
          `- demo: [${removeProtocolFromUrl(service.demo)}](${service.demo})\n\n` +
      `# state\n[${removeProtocolFromUrl(state)}](${state})\n`;
}

function formatAttributes(data, model, service, state) {
  return [
    {
      trait_type: 'data',
      value: data
    },
    {
      trait_type: 'model',
      value: JSON.stringify(model)
    },
    {
      trait_type: 'service',
      value: JSON.stringify(service)
    },
    {
      trait_type: 'state',
      value: state
    }
  ];
}

app.get('/:tokenId', async (req, res) => {
  const tokenId = req.params.tokenId;
  const ain = new Ain(ainProviderUrl);
  const ainftId = await ain.db.ref(`/apps/teachable_ainft/hrc721_to_ainft/${tokenId}`).getValue()
    .catch((error) => {
      logger.error(`Failed to get ainft id: ${tokenId} ${error}`);
      return null;
    });
  logger.info(`tokenId = ${tokenId} (${ainftId})`);
  if (ainftId === null) {
    return res.status(404).send();
  }
  const ainftMetadata = await ain.db.ref(`/apps/${ainftId}/metadata`).getValue()
    .catch((error) => {
      logger.error(`Failed to get ainft metadata: ${tokenId}, ${ainftId}, ${error}`);
      return null;
    });
  if (!ainftMetadata || !ainftMetadata.data || !ainftMetadata.model || !ainftMetadata.service ||
      !ainftMetadata.state || !ainftMetadata.ainftImageUrl) {
    return res.status(404).send();
  }
  const { data, model, service, state } = ainftMetadata;
  const metadata = {
    name: ainftId,
    description: formatDescription(data, model, service, state),
    image: ainftMetadata.ainftImageUrl,
    attributes: formatAttributes(data, model, service, state),
  }
  return res.status(200).json(metadata);
});

exports.ainftMetadataHarmony = functions.https.onRequest(app);

async function setTeachableAinftAdminKey(ain) {
  const keystore = (await storage.bucket(functions.config().storage_bucket.keystore_url)
      .file('keystore_ainft_admin.json').download()).toString();
  const adminKeystorePassword = _.get(functions.config(), 'ain.ainft_keystore_password');
  const address = ain.wallet.addFromV3Keystore(keystore, adminKeystorePassword);
  ain.wallet.setDefaultAccount(address);
  logger.info(`ainft admin set as ${address}`);
}

async function moveHrc721MintTx(txHash, ainftAppName, txReceipt) {
  await admin.database().ref().update({
    [`teachable_ainft/hrc721_mint_pending_txs/${txHash}`]: null,
    [`teachable_ainft/hrc721_mint_confirmed_txs/${txHash}`]: {
      ainftAppName,
      txReceipt,
      createdAt: admin.database.ServerValue.TIMESTAMP
    }
  })
    .catch((error) => {
      logger.error(`Failed to move hrc721 mint tx: ${txHash}, ${ainftAppName}, ` +
          `${JSON.stringify(txReceipt, null, 2)}, ${error}`);
    });
}

async function isAinTxFinalized(ain, txHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId, setMappingRes) {
  const tx = await ain.getTransaction(txHash)
    .catch((error) => {
      logger.error(`Failed to get ain transaction: ${txHash}, ${error}`);
      return null;
    });
  logger.debug(`hrc721_to_ainft mapping set tx: ${txHash}, ${JSON.stringify(tx, null, 2)}`);
  if (tx.receipt && tx.receipt.code !== 0) {
    // Should not happen.
    const errorMsg = 'hrc721_to_ainft mapping set tx finalized but failed';
    logger.error(errorMsg);
    await sendSlackMessage(errorMsg, txHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId, setMappingRes);
  }
  return tx && tx.state === 'FINALIZED';
}

async function sendSlackMessage(message, txHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId, setMappingRes) {
  if (webhook) {
    const text = `[${process.env.GCLOUD_PROJECT}][HARMONY] ${message}:` +
        `\n  txHash: ${txHash}\n  ainftAppName: ${ainftAppName}` +
        `\n  sourceNftAddress: ${sourceNftAddress}\n  sourceNftTokenId: ${sourceNftTokenId}` +
        `\n  tokenId: ${tokenId}` +
        (setMappingRes ? `\n  setMappingRes: ${JSON.stringify(setMappingRes)}` : '');
    try {
      await webhook.send({
        pretext: '*Teachable AI NFT Mapping Error*',
        text,
        color: 'danger'
      });
    } catch(error) {
      logger.debug(`Failed to send slack message: ${error}`);
    }
  }
}

exports.ainftMappingSchedulerHarmony = functions.runWith({ memory: '1GB', timeoutSeconds: 300 }) // 5 min
  .pubsub
  .schedule('*/5 * * * *') // every 5 min
  .onRun(async () => {
    const pendingTxs = (await admin.database().ref('teachable_ainft/hrc721_mint_pending_txs').once('value')).val();
    logger.debug(`Pending txs: ${JSON.stringify(pendingTxs, null, 2)}`);
    if (!pendingTxs) {
      return;
    }
    const lastRun = await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run').once('value');
    if (lastRun.exists()) {
      // Timed out while waiting for tx confirmation or set value failed.
      logger.info(`Last run didn't finish successfully: ${JSON.stringify(lastRun.val(), null, 2)}`);
      return;
    }

    const ain = new Ain(ainProviderUrl, isProd ? 1 : 0);
    const ainftAdminAddress = await setTeachableAinftAdminKey(ain);
    const web3 = new Web3(harmonyProviderUrl);
    for (const [txHash, ainftAppName] of Object.entries(pendingTxs)) {
      logger.debug(`Processing: ${txHash}, ${ainftAppName}`);
      const txReceipt = await web3.eth.getTransactionReceipt(txHash)
        .catch((error) => {
          logger.error(`Failed to get tx receipt: ${error}`);
          return null;
        });
      logger.debug(`txReceipt: ${JSON.stringify(txReceipt, null, 2)}`);
      if (!txReceipt) {
        logger.debug(`Tx not confirmed yet`);
        continue;
      }
      if (!txReceipt.status) {
        // Should not happen.
        logger.error(`Tx reverted`);
        await moveHrc721MintTx(txHash, ainftAppName, txReceipt);
        continue;
      }
      const mintEventLog = txReceipt.logs.find((log) =>
          _.get(log, 'topics.0') === TEACHABLE_AINFT_ERC721_MINT_EVENT_TOPIC); // Same for harmony
      if (!mintEventLog) {
        // Should not happen. Ignore the tx hash.
        logger.error(`Invalid tx hash (mint event not found)`);
        await moveHrc721MintTx(txHash, ainftAppName, txReceipt);
        continue;
      }
      let decodedParams;
      try {
        decodedParams = web3.eth.abi.decodeLog(
            TEACHABLE_AINFT_ERC721_MINT_EVENT_TYPE_ARR, mintEventLog.data, mintEventLog.topics.slice(1)); // Same for harmony
      } catch (error) {
        logger.error(`Error while decoding params: ${error}`);
      }
      if (!decodedParams) {
        // Should not happen. Ignore the tx hash.
        logger.error('Failed to decode params');
        await moveHrc721MintTx(txHash, ainftAppName, txReceipt);
        continue;
      }
      const { sourceNftAddress, sourceNftTokenId, tokenId } = decodedParams;
      logger.info(`sourceNftAddress: ${sourceNftAddress}, sourceNftTokenId: ${sourceNftTokenId}, tokenId: ${tokenId}`);
      const mappingPath = `/apps/teachable_ainft/hrc721_to_ainft/${tokenId}`;
      const mappingExists = await ain.db.ref(mappingPath).getValue()
        .catch((error) => {
          logger.error(`Failed to get hrc721_to_ainft mapping: ${error}`);
          return null;
        });
      if (mappingExists) {
        logger.info('Mapping already exists');
        await moveHrc721MintTx(txHash, ainftAppName, txReceipt);
        continue;
      }

      let errorMsg;
      await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run').set({
        txHash,
        ainftAppName,
        txReceipt,
        sourceNftAddress,
        sourceNftTokenId,
        tokenId
      });
      const setMappingRes = await ain.db.ref(mappingPath).setValue({
          value: ainftAppName,
          nonce: -1,
          gas_price: 500,
          address: ainftAdminAddress
        })
        .catch(async (error) => {
          errorMsg = `Failed to set hrc721_to_ainft mapping: ${error}`;
          await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run/error').set(errorMsg);
          return null;
        });
      logger.debug(`setMappingRes: ${JSON.stringify(setMappingRes, null, 2)}`);
      if (!setMappingRes) {
        if (!errorMsg) {
          errorMsg = 'Something went wrong while setting hrc721_to_ainft mapping';
          await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run/error').set(errorMsg);
        }
        logger.error(errorMsg);
        await sendSlackMessage(
            errorMsg, txHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId);
        // Stop the current run.
        return;
      }
      const ainTxHash = setMappingRes.tx_hash;
      await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run/setMappingRes').set(setMappingRes);
      if (setMappingRes.result.code === 0) {
        let txFinalized = (await isAinTxFinalized(
            ain, ainTxHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId, setMappingRes));
        while (!txFinalized) {
          sleep(10);
          txFinalized = (await isAinTxFinalized(
              ain, ainTxHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId, setMappingRes));
        }
        await moveHrc721MintTx(txHash, ainftAppName, txReceipt);
        await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run').remove();
      } else {
        const errorMsg = 'Failed to set hrc721 token id -> ainft id mapping';
        logger.error(errorMsg);
        await admin.database().ref('teachable_ainft/hrc_mapping_scheduler/last_run/error').set(errorMsg);
        await sendSlackMessage(
            errorMsg, txHash, ainftAppName, sourceNftAddress, sourceNftTokenId, tokenId, setMappingRes);
        // Stop the current run.
        return;
      }
    }
  });
