import {
  PublicKey, Keypair, Connection, Transaction, ComputeBudgetProgram,
  sendAndConfirmTransaction, VersionedTransaction, TransactionMessage,
  TransactionInstruction, SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, getAssociatedTokenAddress, getMint, getMinimumBalanceForRentExemptAccount,
  createSyncNativeInstruction
} from "@solana/spl-token";
import base58 from "bs58";
import path from 'path'
import fs from 'fs'
import { retrieveEnvVariable, saveDataToFile, sleep } from "./src/utils";
import { bundle } from "./src/jito";
import { Liquidity, LiquidityPoolKeysV4, MAINNET_PROGRAM_ID, InstructionType, Percent, CurrencyAmount, Token, SOL, LiquidityPoolInfo } from "@raydium-io/raydium-sdk";
import { derivePoolKeys } from "./src/poolAll";
import { lookupTableProvider } from "./src/lut";
import { BN } from "bn.js";
import { ConnectedLeadersRegionedRequest } from "jito-ts/dist/gen/block-engine/searcher";

// Environment Variables3
const baseMintStr = retrieveEnvVariable('BASE_MINT');
const mainKpStr = retrieveEnvVariable('MAIN_KP');
const rpcUrl = retrieveEnvVariable("RPC_URL");
const isJito: boolean = retrieveEnvVariable("IS_JITO") === "true";
let buyMax = Number(retrieveEnvVariable('SOL_BUY_MAX'));
let buyMin = Number(retrieveEnvVariable('SOL_BUY_MIN'));
let interval = Number(retrieveEnvVariable('INTERVAL'));
const jito_tx_interval = Number(retrieveEnvVariable('JITO_TX_TIME_INTERVAL')) > 10 ?
  Number(retrieveEnvVariable('JITO_TX_TIME_INTERVAL')) : 10
const poolId = retrieveEnvVariable('POOL_ID');

// Solana Connection and Keypair
const connection = new Connection(rpcUrl, { commitment: "processed" });
const mainKp = Keypair.fromSecretKey(base58.decode(mainKpStr));
const baseMint = new PublicKey(baseMintStr);

let poolKeys: LiquidityPoolKeysV4 | null = null;
let tokenAccountRent: number | null = null;
let decimal: number | null = null;
let poolInfo: LiquidityPoolInfo | null = null;

let maker = 0
let now = Date.now()
let unconfirmedKps: Keypair[] = []

/**
 * Executes a buy and sell transaction for a given token.
 * @param {PublicKey} token - The token's public key.
 */
const buySellToken = async (token: PublicKey, newWallet: Keypair, solBuyAmountLamports: number) => {
  try {
    if (!tokenAccountRent)
      tokenAccountRent = await getMinimumBalanceForRentExemptAccount(connection);
    if (!decimal)
      decimal = (await getMint(connection, token)).decimals;
    if (!poolKeys) {
      poolKeys = await derivePoolKeys(new PublicKey(poolId))
      if (!poolKeys) {
        console.log("Pool keys is not derived")
        return
      }
    }

    // const solBuyAmountLamports = Math.floor((Math.random() * (buyMax - buyMin) + buyMin) * 10 ** 9);
    const quoteAta = await getAssociatedTokenAddress(NATIVE_MINT, mainKp.publicKey);
    const baseAta = await getAssociatedTokenAddress(token, mainKp.publicKey);
    const newWalletBaseAta = await getAssociatedTokenAddress(token, newWallet.publicKey);
    const newWalletQuoteAta = await getAssociatedTokenAddress(NATIVE_MINT, newWallet.publicKey);

    const slippage = new Percent(100, 100);
    const inputTokenAmount = new CurrencyAmount(SOL, solBuyAmountLamports);
    const outputToken = new Token(TOKEN_PROGRAM_ID, baseMint, decimal);

    if (!poolInfo)
      poolInfo = await Liquidity.fetchInfo({ connection, poolKeys })

    const { amountOut, minAmountOut } = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn: inputTokenAmount,
      currencyOut: outputToken,
      slippage,
    });

    const { amountIn, maxAmountIn } = Liquidity.computeAmountIn({
      poolKeys,
      poolInfo,
      amountOut,
      currencyIn: SOL,
      slippage
    })

    const { innerTransaction: innerBuyIxs } = Liquidity.makeSwapFixedOutInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: quoteAta,
          tokenAccountOut: baseAta,
          owner: mainKp.publicKey,
        },
        maxAmountIn: maxAmountIn.raw,
        amountOut: amountOut.raw,
      },
      poolKeys.version,
    )

    const { innerTransaction: innerSellIxs } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: baseAta,
          tokenAccountOut: quoteAta,
          owner: mainKp.publicKey,
        },
        amountIn: amountOut.raw.sub(new BN(10 ** decimal)),
        minAmountOut: 0,
      },
      poolKeys.version,
    );

    const instructions: TransactionInstruction[] = [];
    const latestBlockhash = await connection.getLatestBlockhash();
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),

      createAssociatedTokenAccountIdempotentInstruction(
        mainKp.publicKey,
        newWalletBaseAta,
        newWallet.publicKey,
        baseMint,
      ),
      ...innerBuyIxs.instructions,
      createTransferCheckedInstruction(
        baseAta,
        baseMint,
        newWalletBaseAta,
        mainKp.publicKey,
        10 ** decimal,
        decimal
      ),
      ...innerSellIxs.instructions,
      SystemProgram.transfer({
        fromPubkey: newWallet.publicKey,
        toPubkey: mainKp.publicKey,
        lamports: 1_002_304,
      }),
    )

    const messageV0 = new TransactionMessage({
      payerKey: newWallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([mainKp, newWallet])

    if (isJito)
      return transaction

    // console.log(await connection.simulateTransaction(transaction))
    const sig = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true })
    const confirmation = await connection.confirmTransaction(
      {
        signature: sig,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      "confirmed"
    )
    if (confirmation.value.err) {
      console.log("Confrimtaion error")
      return newWallet
    } else {
      maker++
      console.log(`Buy and sell transaction: https://solscan.io/tx/${sig} and maker is ${maker}`);
    }
  } catch (error) {
  }
};

/**
 * Wraps the given amount of SOL into WSOL.
 * @param {Keypair} mainKp - The central keypair which holds SOL.
 * @param {number} wsolAmount - The amount of SOL to wrap.
 */
const wrapSol = async (mainKp: Keypair, wsolAmount: number) => {
  try {
    const wSolAccount = await getAssociatedTokenAddress(NATIVE_MINT, mainKp.publicKey);
    const baseAta = await getAssociatedTokenAddress(baseMint, mainKp.publicKey);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 461197 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 51337 }),
    );
    // if (!await connection.getAccountInfo(wSolAccount))
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        mainKp.publicKey,
        wSolAccount,
        mainKp.publicKey,
        NATIVE_MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: mainKp.publicKey,
        toPubkey: wSolAccount,
        lamports: wsolAmount,
      }),
      createSyncNativeInstruction(wSolAccount, TOKEN_PROGRAM_ID),
    )
    if (!await connection.getAccountInfo(baseAta))
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          mainKp.publicKey,
          baseAta,
          mainKp.publicKey,
          baseMint,
        ),
      )

    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
    tx.feePayer = mainKp.publicKey
    const sig = await sendAndConfirmTransaction(connection, tx, [mainKp], { skipPreflight: true, commitment: "confirmed" });
    console.log(`Wrapped SOL transaction: https://solscan.io/tx/${sig}`);
    await sleep(5000);
  } catch (error) {
    console.error("wrapSol error");
  }
};

/**
 * Unwraps WSOL into SOL.
 * @param {Keypair} mainKp - The main keypair.
 */
const unwrapSol = async (mainKp: Keypair) => {
  const wSolAccount = await getAssociatedTokenAddress(NATIVE_MINT, mainKp.publicKey);
  try {
    const wsolAccountInfo = await connection.getAccountInfo(wSolAccount);
    if (wsolAccountInfo) {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 261197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createCloseAccountInstruction(
          wSolAccount,
          mainKp.publicKey,
          mainKp.publicKey,
        ),
      );
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
      tx.feePayer = mainKp.publicKey
      const sig = await sendAndConfirmTransaction(connection, tx, [mainKp], { skipPreflight: true, commitment: "confirmed" });
      console.log(`Unwrapped SOL transaction: https://solscan.io/tx/${sig}`);
      await sleep(5000);
    }
  } catch (error) {
    console.error("unwrapSol error:", error);
  }
};

function loadInterval() {
  const data = fs.readFileSync(path.join(__dirname, 'interval.txt'), 'utf-8')
  const num = Number(data.trim())
  if(isNaN(num)) {
    console.log("Interval number in interval.txt is incorrect, plz fix and run again")
    return
  }
  interval = num
}

/**
 * Main function to run the maker bot.
 */
const run = async () => {

};

// Main function that runs the bot
run();


// You can run the wrapSOL function to wrap some sol in central wallet for any reasone
// wrapSol(mainKp, 0.2)

// unWrapSOl function to unwrap all WSOL in central wallet that is in the wallet
// unwrapSol(mainKp)

