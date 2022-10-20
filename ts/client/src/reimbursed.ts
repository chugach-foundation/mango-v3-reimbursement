import {
  Cluster,
  Config,
  MangoClient,
} from "@blockworks-foundation/mango-client";
import { AnchorProvider, Provider, Wallet } from "@project-serum/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
  TYPE_SIZE,
} from "@solana/spl-token";
import { MangoV3ReimbursementClient } from "./client";
import BN from "bn.js";
import fs from "fs";
import { coder } from "@project-serum/anchor/dist/cjs/spl/token";

/// Env
const CLUSTER_URL = process.env.MB_CLUSTER_URL;
const PAYER_KEYPAIR = process.env.MB_PAYER_KEYPAIR;
const GROUP_NUM = Number(process.env.GROUP_NUM || 1);
const CLUSTER: any = "mainnet-beta";
const MANGO_V3_CLUSTER: Cluster = "mainnet";
const MANGO_V3_GROUP_NAME: any = "mainnet.1";

const options = AnchorProvider.defaultOptions();
const connection = new Connection(CLUSTER_URL!, options);

// Mango v3 client setup
const config = Config.ids();
const groupIds = config.getGroup(MANGO_V3_CLUSTER, MANGO_V3_GROUP_NAME);
if (!groupIds) {
  throw new Error(`Group ${MANGO_V3_GROUP_NAME} not found`);
}
const mangoProgramId = groupIds.mangoProgramId;
const mangoGroupKey = groupIds.publicKey;
const mangoV3Client = new MangoClient(connection, mangoProgramId);

async function main() {
  // Client setup
  let sig;
  const admin = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(PAYER_KEYPAIR!, "utf-8")))
  );
  const adminWallet = new Wallet(admin);
  const provider = new AnchorProvider(connection, adminWallet, options);
  const mangoV3ReimbursementClient = new MangoV3ReimbursementClient(provider);

  // load group
  let group = (
    await mangoV3ReimbursementClient.program.account.group.all()
  ).find((group) => group.account.groupNum === GROUP_NUM);

  // load table
  const rows = await mangoV3ReimbursementClient.decodeTable(group.account);

  let reimbursed = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let toBeReimbursed = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  // load all reimbursementAccounts
  const ras =
    await mangoV3ReimbursementClient.program.account.reimbursementAccount.all();

  const v3group = await mangoV3Client.getMangoGroup(mangoGroupKey);

  for (const [rowIndex, row] of rows.entries()) {
    const reimbursementAccount = (
      await PublicKey.findProgramAddress(
        [
          Buffer.from("ReimbursementAccount"),
          group?.publicKey.toBuffer()!,
          row.owner.toBuffer(),
        ],
        mangoV3ReimbursementClient.program.programId
      )
    )[0];

    // find reimbursementAccount
    const ra = ras.find((entry) =>
      entry.publicKey.equals(reimbursementAccount)
    );

    // if reimbursementAccount was not yet created
    if (!ra) {
      for (const [tokenIndex, tokenInfo] of v3group.tokens.entries()!) {
        const token = groupIds?.tokens.find((token) =>
          token.mintKey.equals(tokenInfo.mint)
        );
        if (!token) {
          continue;
        }
        toBeReimbursed[tokenIndex] =
          toBeReimbursed[tokenIndex] + row.balances[tokenIndex].toNumber();
      }
      continue;
    }

    // tally where reimbursementAccount was created
    for (const [tokenIndex, tokenInfo] of v3group.tokens.entries()!) {
      const token = groupIds?.tokens.find((token) =>
        token.mintKey.equals(tokenInfo.mint)
      );
      if (!token) {
        continue;
      }
      // token was reimbursed
      if (mangoV3ReimbursementClient.reimbursed(ra.account, 0)) {
        reimbursed[tokenIndex] =
          reimbursed[tokenIndex] + row.balances[tokenIndex].toNumber();
      }
      // token was not reimbursed
      else {
        toBeReimbursed[tokenIndex] =
          toBeReimbursed[tokenIndex] + row.balances[tokenIndex].toNumber();
      }
    }
  }

  console.log(
    `${"Token".padStart(5)} ${"Reimbursed".padStart(
      15
    )} ${"ClaimMintSupply".padStart(15)} ${"ToBeReimbursed".padStart(
      15
    )} ${"Vault".padStart(15)} ${"VaultAccount".padStart(
      15
    )} (${new Date().toTimeString()})`
  );
  for (const [tokenIndex, tokenInfo] of (
    await mangoV3Client.getMangoGroup(mangoGroupKey)
  ).tokens.entries()!) {
    const token = groupIds?.tokens.find((token) =>
      token.mintKey.equals(tokenInfo.mint)
    );
    if (!token) {
      continue;
    }

    const vault = coder()
      .accounts.decode(
        "token",
        (await mangoV3ReimbursementClient.program.provider.connection.getAccountInfo(
          group.account.vaults[tokenIndex]
        ))!.data
      )
      .amount.toNumber();

    const claimMintSupply = coder()
      .accounts.decode(
        "mint",
        (await mangoV3ReimbursementClient.program.provider.connection.getAccountInfo(
          group.account.claimMints[tokenIndex]
        ))!.data
      )
      .supply.toNumber();

    const reimbursedString = (
      reimbursed[tokenIndex] / Math.pow(10, token.decimals)
    )
      .toFixed(5)
      .padStart(15);

    const claimMintSupplyString = (
      claimMintSupply / Math.pow(10, token.decimals)
    )
      .toFixed(5)
      .padStart(15);

    const toBeReimbursedString = (
      toBeReimbursed[tokenIndex] / Math.pow(10, token.decimals)
    )
      .toFixed(5)
      .padStart(15);

    const vaultBalanceString = (vault / Math.pow(10, token.decimals))
      .toFixed(5)
      .padStart(15);

    console.log(
      `${token.symbol.padStart(
        5
      )} ${reimbursedString} ${claimMintSupplyString} ${toBeReimbursedString} ${vaultBalanceString} (https://explorer.solana.com/address/${
        group.account.vaults[tokenIndex]
      })`
    );
  }
}

main();
