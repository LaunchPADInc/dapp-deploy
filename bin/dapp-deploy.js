#! /usr/bin/env node

const yargs = require('yargs')
const Web3 = require('web3')
const Q = require('q')
const fs = require('fs')

const argv = yargs
    .usage(`
Tool to use in combination with 'dapphub/dapp'.
Uses artifacts generated by "dapp build".
Deploys compiled contract(s) to an Ethereum blockchain.

Each deployed contract address is saved to a JSON data file.
Format is a hash table:
    Ethereum network ID => array of addresses

Ethereum network ID represents a unique Ethereum blockchain.
Enables deployment to multiple chains.

A frontend Dapp can determine the current Ethereum network ID.
For each contract, the Dapp can perform the necessary lookup
in the corresponding hash table of deployment addresses.
Using web3.js, only 2 data files are needed per contract:
    ./out/CONTRACTNAME.abi
    ./out/CONTRACTNAME.deployed

Usage: $0 [options]
`)
    .option('all', {
      describe: 'Deploy all contracts',
      boolean: true,
      default: true
    })
    .option('c', {
      alias: 'contract',
      describe: 'Deploy only specified contract(s)',
      string: true,
      array: true
    })
    .option('params', {
      describe: 'Parameter(s) to pass to contract constructor(s)' + "\n" + 'note: In most situations, each contract having a constructor that accepts input parameters should be deployed individually, rather than in a batch. Please be careful.',
      array: true,
      default: []
    })
    .option('value', {
      alias: 'wei',
      describe: 'Value (wei) to pass to contract constructor(s)' + "\n" + 'note: In most situations, each contract having a payable constructor should be deployed individually, rather than in a batch. Please be careful.',
      number: true,
      default: 0
    })
    .option('gas', {
      describe: 'Gas to send with each transaction' + "\n" + 'note: In most situations, it would be better to not use this option. By default, the amount of gas sent is an estimate.',
      number: true
    })
    .option('h', {
      alias: 'host',
      describe: 'Ethereum JSON-RPC server hostname',
      string: true,
      default: 'localhost'
    })
    .option('p', {
      alias: 'port',
      describe: 'Ethereum JSON-RPC server port number',
      number: true,
      default: 8545
    })
    .option('tls', {
      alias: ['https', 'ssl'],
      describe: 'Require TLS handshake (https:) to connect to Ethereum JSON-RPC server',
      boolean: true,
      default: false
    })
    .option('a', {
      alias: ['aa', 'account_address'],
      describe: 'Address of Ethereum account to own deployed contracts',
      string: true,
      nargs: 1
    })
    .option('A', {
      alias: ['ai', 'account_index'],
      describe: 'Index of Ethereum account to own deployed contracts.' + "\n" + 'note: List of available/unlocked accounts is determined by Ethereum client.',
      number: true,
      nargs: 1,
      default: 0
    })
    .option('i', {
      alias: 'input_directory',
      describe: 'Path to input directory. All compiled contract artifacts are read from this directory.' + "\n" + 'note: The default path assumes that the current directory is the root of a compiled "dapp" project.',
      string: true,
      nargs: 1,
      default: './out'
    })
    .option('o', {
      alias: ['od', 'output_directory'],
      describe: 'Path to output directory. All "contract.deployed" JSON files will be written to this directory.',
      string: true,
      nargs: 1,
      default: './out'
    })
    .option('O', {
      alias: ['op', 'output_pattern'],
      describe: 'Pattern to specify absolute output file path. The substitution pattern "{{contract}}" will be interpolated.' + "\n" + 'note: The substitution pattern is required.',
      string: true,
      nargs: 1
    })
    .option('v', {
      alias: 'verbose',
      describe: 'Configure how much information is logged to the console during the deployment of contracts.',
      count: true
    })
    .option('q', {
      alias: 'quiet',
      describe: 'Disable log messages. Output is restricted to the address(es) of newly deployed contracts. If a single contract is specified, returns a string. Otherwise, returns a hash (name => address) in JSON format. This data can be piped to other applications.',
      boolean: true,
      default: false
    })
    .example('$0', 'deploy all contracts via: "http://localhost:8545" using account index #0')
    .example('$0 -A 1', 'deploy all contracts via: "http://localhost:8545" using account index #1')
    .example('$0 -h "mainnet.infura.io" -p 443 --ssl -a "0xB9903E9360E4534C737b33F8a6Fef667D5405A40"', 'deploy all contracts via: "https://mainnet.infura.io:443" using account address "0xB9903E9360E4534C737b33F8a6Fef667D5405A40"')
    .example('$0 -c Foo', 'deploy contract: "Foo"')
    .example('$0 -c Foo --params bar baz 123 --value 100', 'deploy contract: "Foo"' + "\n" + 'call: "Foo(\'bar\', \'baz\', 123)"' + "\n" + 'pay to contract: "100 wei"')
    .example('$0 -c Foo Bar Baz', 'deploy contracts: ["Foo","Bar","Baz"]')
    .example('$0 -c Foo -o "~/Dapp_frontend/contracts"', 'generate: "~/Dapp_frontend/contracts/Foo.deployed"')
    .example('$0 -c Foo -O "~/Dapp_frontend/contracts/{{contract}}.deployed.json"', 'generate: "~/Dapp_frontend/contracts/Foo.deployed.json"')
    .example('$0 -c Foo -i "~/Dapp_contracts/out" -O "./contracts/{{contract}}.deployed.json"', 'deploy contract: "~/Dapp_contracts/out/Foo.bin"' + "\n" + 'and generate: "./contracts/Foo.deployed.json"')
    .help('help')
    .epilog("copyright: Warren Bank <github.com/warren-bank>\nlicense: GPLv2")
    .argv

const https = argv.tls
const host = argv.h
const port = argv.p

const params = argv.params
const wei = argv.wei
const gas = argv.gas

const account_address = argv.aa
const account_index = argv.ai

const input_directory = argv.i
const output_directory = argv.od
const output_pattern = argv.op

const QUIET = argv.q
const VERBOSE_LEVEL = QUIET ? -1 : argv.v
const PIPE  = function() { VERBOSE_LEVEL <  0 && process.stdout.write.apply(process.stdout, arguments) }
const WARN  = function() { VERBOSE_LEVEL >= 0 && console.log.apply(console, arguments) }
const INFO  = function() { VERBOSE_LEVEL >= 1 && console.log.apply(console, arguments) }
const DEBUG = function() { VERBOSE_LEVEL >= 2 && console.log.apply(console, arguments) }

var regex

const ls = function(path, file_ext){
  var files
  file_ext = file_ext.replace(/^\.*(.*)$/, '$1')
  regex = new RegExp('\.' + file_ext + '$')
  files = fs.readdirSync(path)
  files = files.filter((file) => {
    return file.match(regex)
  })
  return files
}

var bins, abis
try {
  bins = ls(input_directory, '.bin')
  abis = ls(input_directory, '.abi')
}
catch(error){
  WARN(error.message)
  WARN("\n")
  process.exit(1)
}

// verify each .bin has a corresponding .abi
regex = /\.bin$/
bins = bins.filter((bin) => {
  var abi = bin.replace(regex, '.abi')
  return (abis.indexOf(abi) >= 0)
})

// ignore unspecified contracts
if (argv.c && argv.c.length){
  regex = new RegExp('(?:^|/)(?:' + argv.c.join('|') + ')\.bin$')
  bins = bins.filter((bin) => {
    return bin.match(regex)
  })
}

var web3, network_id, owner

Q.fcall(function () {
  web3 = new Web3(new Web3.providers.HttpProvider('http' + (https? 's' : '') + '://' + host + ':' + port))

  if (! web3.isConnected){
    throw new Error('[Error] Unable to connect to Ethereum client')
  }

  network_id = web3.version.network

  var accounts
  if (account_address){
    owner = account_address
  }
  else {
    accounts = web3.eth.accounts

    if (accounts.length === 0){
      throw new Error('[Error] The Ethereum client cannot access any unlocked accounts')
    }

    if (account_index >= accounts.length){
      throw new Error('[Error] The Ethereum client can only access ' + accounts.length + ' unlocked accounts, which are indexed #0..' + (accounts.length-1) + '. The specified index #' + account_index + ' is out-of-bounds.')
    }

    if (account_index < 0){
      throw new Error('[Error] The specified index #' + account_index + ' is invalid')
    }

    owner = accounts[account_index]
  }
})
.then(() => {
  var promises = []

  regex = /\.bin$/
  bins.forEach((bin) => {
    var contract_name = bin.replace(regex, '')
    promises.push(deploy_contract(contract_name))
  })

  return Q.all(promises)
})
.catch((error) => {
  WARN(error.message)
  WARN("\n")
  process.exit(1)
})
.then((results) => {
  var piped_result

  if (QUIET){
    if (results.length === 1){
      piped_result = results[0].address
      PIPE(piped_result)
    }
    else {
      piped_result = JSON.stringify(results)
      PIPE(piped_result)
    }
  }

  WARN("\n")
  process.exit(0)
})

function deploy_contract (contract_name){
  var bin_filepath, abi_filepath, contract_bin, contract_abi, $contract, gas_estimate, contract_constructor_parameters, contract_data, deployed_contract_address, promise
  var deferred = Q.defer()

  bin_filepath = input_directory + '/' + contract_name + '.bin'
  abi_filepath = input_directory + '/' + contract_name + '.abi'

  contract_bin = fs.readFileSync(bin_filepath).toString()
  contract_abi = fs.readFileSync(abi_filepath).toString()

  $contract = web3.eth.contract(JSON.parse(contract_abi))

  if (gas){
    gas_estimate = gas
  }
  else if (params.length === 0) {
    try {
      gas_estimate = web3.eth.estimateGas({data: contract_bin})
    }
    catch(error){
      deferred.reject(new Error('[Error] Deployment of "' + contract_name + '" contract failed with the following information:' + "\n" + error.message))
      return deferred.promise
    }
  }
  else {
    try {
      contract_constructor_parameters = params.slice()
      contract_constructor_parameters.push({data: contract_bin})
      contract_data = $contract.new.getData.apply($contract, contract_constructor_parameters)
      gas_estimate = web3.eth.estimateGas({data: contract_data})
    }
    catch(error){
      deferred.reject(new Error('[Error] Deployment of "' + contract_name + '" contract failed with the following information:' + "\n" + error.message))
      return deferred.promise
    }
  }

  contract_constructor_parameters = (params.length)? params.slice() : []
  contract_constructor_parameters.push({
    data: contract_bin,
    from: owner,
    gas: gas_estimate,
    value: wei
  })
  contract_constructor_parameters.push((error, deployed_contract) => {
    if (error){
      deferred.reject(new Error('[Error] Deployment of "' + contract_name + '" contract failed with the following information:' + "\n" + error.message))
    }
    if (! deployed_contract.address) {
      DEBUG('[Notice] Transaction hash for deployment of "' + contract_name + '" contract:' + "\n    " + deployed_contract.transactionHash)
    }
    else {
      deployed_contract_address = deployed_contract.address
      INFO('[Notice] "' + contract_name + '" contract has successfully been deployed at address:' + "\n    " + deployed_contract_address)
      deferred.resolve()
    }
  })

  $contract.new.apply($contract, contract_constructor_parameters)

  promise = deferred.promise
  .then(() => {
    return save_deployment_address(contract_name, deployed_contract_address)
  })

  return promise
}

function save_deployment_address(contract_name, deployed_contract_address){
  var deployments_filepath, contract_deployments, file_exists, promise
  var deferred = Q.defer()

  if (output_pattern){
    deployments_filepath = output_pattern.replace(/\{\{contract\}\}/, contract_name)
  }
  else {
    deployments_filepath = output_directory + '/' + contract_name + '.deployed'
  }

  fs.stat(deployments_filepath, (error, stats) => {
    file_exists = (!error && stats.isFile())
    deferred.resolve()
  })

  promise = deferred.promise
  .then(() => {
    if (file_exists){
      try {
        contract_deployments = fs.readFileSync(deployments_filepath).toString()
      }
      catch (error){
        throw new Error('[Error] Reading of file "' + deployments_filepath + '" failed with the following information:' + "\n" + error.message)
      }
      try {
        contract_deployments = JSON.parse( contract_deployments )
      }
      catch (error){
        throw new Error('[Error] Parsing of JSON data in "' + deployments_filepath + '" failed with the following information:' + "\n" + error.message)
      }
    }
    else {
      contract_deployments = {}
    }

    if (typeof contract_deployments[network_id] === 'undefined'){
      contract_deployments[network_id] = []
    }
    contract_deployments[network_id].push(deployed_contract_address)

    try {
      fs.writeFileSync(deployments_filepath, JSON.stringify(contract_deployments))
      WARN('[Notice] Address of deployed "' + contract_name + '" contract has successfully been added to file:' + "\n    " + deployments_filepath)
    }
    catch (error){
      throw new Error('[Error] Unable to output address of deployed "' + contract_name + '" contract to file "' + deployments_filepath + '". Operation failed with the following information:' + "\n" + error.message)
    }

    return {contract: contract_name, address: deployed_contract_address}
  })

  return promise
}
