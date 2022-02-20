const TEACHABLE_AINFT_ERC721_MINT_EVENT_TYPE_ARR = [
  { type: 'address', name: 'sourceNftAddress', indexed: true },
  { type: 'uint256', name: 'sourceNftTokenId', indexed: true },
  { type: 'uint256', name: 'tokenId', indexed: true },
];

const TEACHABLE_AINFT_ERC721_MINT_EVENT_TOPIC = '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f';

const isProd = process.env.GCLOUD_PROJECT === 'YOUR_PROD_PROJECT_ID';

module.exports = {
  TEACHABLE_AINFT_ERC721_MINT_EVENT_TYPE_ARR,
  TEACHABLE_AINFT_ERC721_MINT_EVENT_TOPIC,
  isProd,
}