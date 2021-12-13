/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as c from '@aws-accelerator/common-config';
import { AccountStack, AccountStacks } from '../../common/account-stacks';
import * as sns from '@aws-cdk/aws-sns';
import * as kms from '@aws-cdk/aws-kms';
import { createSnsTopicName } from '@aws-accelerator/cdk-accelerator/src/core/accelerator-name-generator';
import { SNS_NOTIFICATION_TYPES } from '@aws-accelerator/common/src/util/constants';
import * as path from 'path';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cdk from '@aws-cdk/core';
import { IamRoleOutputFinder } from '@aws-accelerator/common-outputs/src/iam-role';
import { StackOutput } from '@aws-accelerator/common-outputs/src/stack-output';
import * as iam from '@aws-cdk/aws-iam';
import { CfnSnsTopicOutput } from './outputs';
import { Account, getAccountId } from '@aws-accelerator/common-outputs/src/accounts';
import { createDefaultS3Key } from '../defaults/shared';
import { AccountBucketOutputFinder } from '../defaults';
import { LogBucketOutputTypeOutputFinder } from '@aws-accelerator/common-outputs/src/buckets';

export interface SnsStep1Props {
  accountStacks: AccountStacks;
  config: c.AcceleratorConfig;
  outputs: StackOutput[];
  accounts: Account[];
}

/**
 *
 *  Create SNS Topics High, Medium, Low, Ignore
 *  in Central-Log-Services Account
 */
export async function step1(props: SnsStep1Props) {
  const { accountStacks, config, outputs, accounts } = props;
  const globalOptions = config['global-options'];
  const centralLogServices = globalOptions['central-log-services'];
  const centralSecurityServices = globalOptions['central-security-services'];
  const supportedRegions = globalOptions['supported-regions'];
  const excludeRegions = centralLogServices['sns-excl-regions'];
  const managementAccountConfig = globalOptions['aws-org-management'];
  const regions = supportedRegions.filter(r => !excludeRegions?.includes(r));

  if (!regions.includes(centralLogServices.region)) {
    regions.push(centralLogServices.region);
  }
  const subscribeEmails = centralLogServices['sns-subscription-emails'];
  const snsSubscriberLambdaRoleOutput = IamRoleOutputFinder.tryFindOneByName({
    outputs,
    accountKey: centralLogServices.account,
    roleKey: 'SnsSubscriberLambda',
  });
  if (!snsSubscriberLambdaRoleOutput) {
    console.error(`Role required for SNS Subscription Lambda is not created in ${centralLogServices.account}`);
    return;
  }
  const centralLogServicesAccount = getAccountId(accounts, centralLogServices.account)!;
  for (const region of regions) {
    const accountStack = accountStacks.tryGetOrCreateAccountStack(centralLogServices.account, region);
    if (!accountStack) {
      console.error(`Cannot find account stack ${centralLogServices.account}: ${region}, while deploying SNS`);
      continue;
    }

    createSnsTopics({
      accountStack,
      subscriberRoleArn: snsSubscriberLambdaRoleOutput.roleArn,
      region,
      centralServicesRegion: centralLogServices.region,
      subscribeEmails,
      centralAccount: centralLogServicesAccount,
      orgManagementAccount: managementAccountConfig['add-sns-topics']
        ? getAccountId(accounts, managementAccountConfig.account)
        : undefined,
      orgSecurityAccount:
        centralSecurityServices['fw-mgr-alert-level'] !== 'None' || centralSecurityServices['add-sns-topics']
          ? getAccountId(accounts, centralSecurityServices.account)
          : undefined,
      outputs,
    });
  }

  if (managementAccountConfig['add-sns-topics']) {
    const snsSubscriberLambdaRoleMgmtOutput = IamRoleOutputFinder.tryFindOneByName({
      outputs,
      accountKey: managementAccountConfig.account,
      roleKey: 'SnsSubscriberLambda',
    });
    if (!snsSubscriberLambdaRoleMgmtOutput) {
      console.error(`Role required for SNS Subscription Lambda is not created in ${centralLogServices.account}`);
      return;
    }
    const accountStack = accountStacks.tryGetOrCreateAccountStack(
      managementAccountConfig.account,
      centralLogServices.region,
    );
    if (!accountStack) {
      console.error(
        `Cannot find account stack ${managementAccountConfig.account}: ${centralLogServices.region}, while deploying SNS`,
      );
      return;
    }
    createSnsTopics({
      accountStack,
      subscriberRoleArn: snsSubscriberLambdaRoleMgmtOutput.roleArn,
      region: centralLogServices.region,
      centralServicesRegion: centralLogServices.region,
      subscribeEmails,
      centralAccount: centralLogServicesAccount,
      orgManagementSns: true,
      outputs,
    });
  }

  if (centralSecurityServices['add-sns-topics']) {
    const snsSubscriberLambdaRoleMgmtOutput = IamRoleOutputFinder.tryFindOneByName({
      outputs,
      accountKey: centralSecurityServices.account,
      roleKey: 'SnsSubscriberLambda',
    });
    if (!snsSubscriberLambdaRoleMgmtOutput) {
      console.error(`Role required for SNS Subscription Lambda is not created in ${centralLogServices.account}`);
      return;
    }
    for (const region of regions) {
      const accountStack = accountStacks.tryGetOrCreateAccountStack(centralSecurityServices.account, region);
      if (!accountStack) {
        console.error(`Cannot find account stack ${centralLogServices.account}: ${region}, while deploying SNS`);
        continue;
      }
      createSnsTopics({
        accountStack,
        subscriberRoleArn: snsSubscriberLambdaRoleMgmtOutput.roleArn,
        region: centralLogServices.region,
        centralServicesRegion: centralLogServices.region,
        subscribeEmails,
        centralAccount: centralLogServicesAccount,
        orgManagementSns: true,
        outputs,
      });
    }
  }
}

/**
 * Function to create SNS topics in provided accountStack and subscription lambdas and subscriptions based on region
 * @param props
 */
function createSnsTopics(props: {
  accountStack: AccountStack;
  subscriberRoleArn: string;
  region: string;
  centralServicesRegion: string;
  subscribeEmails: {
    [x: string]: string[];
  };
  centralAccount: string;
  /**
   * Used to create separate SNS topics in org management account default region
   */
  orgManagementSns?: boolean;
  /**
   * Org management account for adding publish permissions
   */
  orgManagementAccount?: string;
  /**
   * Org Security account for adding publish permissions
   */
  orgSecurityAccount?: string;

  outputs: StackOutput[];

}) {
  const {
    accountStack,
    centralAccount,
    centralServicesRegion,
    region,
    subscribeEmails,
    subscriberRoleArn,
    orgManagementSns,
    orgManagementAccount,
    orgSecurityAccount,
    outputs
  } = props;
  const lambdaPath = require.resolve('@aws-accelerator/deployments-runtime');
  const lambdaDir = path.dirname(lambdaPath);
  const lambdaCode = lambda.Code.fromAsset(lambdaDir);
  const role = iam.Role.fromRoleArn(accountStack, `SnsSubscriberLambdaRole`, subscriberRoleArn);
  let snsSubscriberFunc: lambda.Function | undefined;
  if (region !== centralServicesRegion || (region === centralServicesRegion && orgManagementSns)) {
    snsSubscriberFunc = new lambda.Function(accountStack, `SnsSubscriberLambda`, {
      runtime: lambda.Runtime.NODEJS_14_X,
      handler: 'index.createSnsPublishToCentralRegion',
      code: lambdaCode,
      role,
      environment: {
        CENTRAL_LOG_SERVICES_REGION: centralServicesRegion,
        CENTRAL_LOG_ACCOUNT: centralAccount,
      },
      timeout: cdk.Duration.minutes(15),
    });

    snsSubscriberFunc.addPermission(`InvokePermission-SnsSubscriberLambda`, {
      action: 'lambda:InvokeFunction',
      principal: new iam.ServicePrincipal('sns.amazonaws.com'),
    });
  }

  const ignoreActionFunc = new lambda.Function(accountStack, `IgnoreActionLambda`, {
    runtime: lambda.Runtime.NODEJS_14_X,
    handler: 'index.createIgnoreAction',
    code: lambdaCode,
    role,
    timeout: cdk.Duration.minutes(15),
  });

  ignoreActionFunc.addPermission(`InvokePermission-IgnoreActionLambda`, {
    action: 'lambda:InvokeFunction',
    principal: new iam.ServicePrincipal('sns.amazonaws.com'),
  });

  const encryptionKey = retrieveExistingKeyFromCentralRegion(outputs, accountStack, centralAccount);

  for (const notificationType of SNS_NOTIFICATION_TYPES) {
    const topicName = createSnsTopicName(notificationType);
    const topic = new sns.Topic(accountStack, `SnsNotificationTopic${notificationType}`, {
      displayName: topicName,
      topicName,
      masterKey: encryptionKey,
    });

    // Allowing Publish from CloudWatch Service form any account
    topic.grantPublish({
      grantPrincipal: new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
    });

    // Allowing Publish from Lambda Service form any account
    topic.grantPublish({
      grantPrincipal: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    if (orgManagementAccount) {
      topic.grantPublish({
        grantPrincipal: new iam.AccountPrincipal(orgManagementAccount),
      });
    }

    if (orgSecurityAccount) {
      topic.grantPublish({
        grantPrincipal: new iam.AccountPrincipal(orgSecurityAccount),
      });
    }

    if (region === centralServicesRegion && subscribeEmails && subscribeEmails[notificationType] && !orgManagementSns) {
      subscribeEmails[notificationType].forEach((email, index) => {
        new sns.CfnSubscription(accountStack, `SNSTopicSubscriptionFor${notificationType}-${index + 1}`, {
          topicArn: topic.topicArn,
          protocol: sns.SubscriptionProtocol.EMAIL,
          endpoint: email,
        });
      });
    } else if (region === centralServicesRegion && notificationType.toLowerCase() === 'ignore') {
      new sns.CfnSubscription(accountStack, `SNSTopicSubscriptionFor${notificationType}`, {
        topicArn: topic.topicArn,
        protocol: sns.SubscriptionProtocol.LAMBDA,
        endpoint: ignoreActionFunc.functionArn,
      });
    } else if (
      (region !== centralServicesRegion || (region === centralServicesRegion && orgManagementSns)) &&
      snsSubscriberFunc
    ) {
      new sns.CfnSubscription(accountStack, `SNSTopicSubscriptionFor${notificationType}`, {
        topicArn: topic.topicArn,
        protocol: sns.SubscriptionProtocol.LAMBDA,
        endpoint: snsSubscriberFunc.functionArn,
      });
    }

    new CfnSnsTopicOutput(accountStack, `SnsNotificationTopic${notificationType}-Otuput`, {
      topicArn: topic.topicArn,
      topicKey: notificationType,
      topicName: topic.topicName,
    });
  }
}


const createDefaultKeyWithPolicyForSns = (accountStack: AccountStack) => {
  const { encryptionKey } = createDefaultS3Key({
    accountStack,
  });

  encryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow SNS to use the encryption key',
      principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
    }),
  );

  encryptionKey.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: 'Allow Cloudwatch and Lambda to send to the topics with encryption',
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
        new iam.ServicePrincipal('lambda.amazonaws.com'),
      ],
      actions: [
        'kms:GenerateDataKey',
        'kms:Decrypt',
      ],
      resources: ['*'],
    }),
  );

  return encryptionKey;
}

const retrieveExistingKeyFromCentralRegion = (outputs: StackOutput[], accountStack: AccountStack, centralAccount: string) => {

  if (accountStack.accountId === centralAccount) {
    const logBucket = LogBucketOutputTypeOutputFinder.findOneByName({
      outputs,
      accountKey: accountStack.accountKey,
      region: accountStack.region
    });

    if (logBucket?.encryptionKeyArn) {
      return kms.Key.fromKeyArn(accountStack, `${accountStack.accountKey}-DefaultKey`, logBucket?.encryptionKeyArn)
    }
    return;
  }

  const accountBucket = AccountBucketOutputFinder.tryFindOneByName({
    outputs,
    accountKey: accountStack.accountKey,
    region: accountStack.region
  })

  if (accountBucket?.encryptionKeyArn) {
    return kms.Key.fromKeyArn(accountStack, `${accountStack.accountKey}-DefaultKey`, accountBucket?.encryptionKeyArn);
  }
  return;

}

