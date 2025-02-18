const crypto = require('crypto');

// Map of word numbers to their numeric values
const wordToNumber = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
    'ten': 10
};

// Map of numbers to their word representations
const numberToWord = {
    0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
    5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine',
    10: 'ten'
};

// Supported operators and their functions
const operators = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '×': (a, b) => a * b,
    '÷': (a, b) => a / b
};

/**
 * Generates a random number between min and max (inclusive)
 */
function getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generates a random operator from the supported list
 */
function getRandomOperator() {
    const ops = Object.keys(operators);
    return ops[Math.floor(Math.random() * ops.length)];
}

/**
 * Creates a captcha equation with either numbers or words
 */
function generateCaptcha(useWords = false) {
    const num1 = getRandomNumber(1, 10);
    const num2 = getRandomNumber(1, 10);
    const operator = getRandomOperator();
    
    // Calculate the result
    const result = operators[operator](num1, num2);
    
    // Generate a unique string for verification
    const timestamp = Date.now().toString();
    const randomString = crypto.randomBytes(5).toString('hex');
    const verificationString = `${timestamp}${randomString}`;
    
    // Create the equation string
    let equation;
    if (useWords) {
        equation = `${numberToWord[num1]} ${operator} ${numberToWord[num2]}`;
    } else {
        equation = `${num1} ${operator} ${num2}`;
    }
    
    return {
        equation,
        result: Math.round(result), // Round for division cases
        verificationString
    };
}

/**
 * Verifies if the provided answer matches the expected result
 */
function verifyCaptcha(answer, expectedResult) {
    return parseInt(answer, 10) === expectedResult;
}

/**
 * Generates the HTML for the captcha
 */
function generateCaptchaHTML(useWords = false) {
    const { equation, result, verificationString } = generateCaptcha(useWords);
    
    return {
        html: `
            <div class="aiowps-captcha-equation">
                <strong>${equation} = 
                    <input type="hidden" name="aiowps-captcha-string-info" class="aiowps-captcha-string-info" value="${verificationString}">
                    <input type="hidden" name="aiowps-captcha-temp-string" class="aiowps-captcha-temp-string" value="${result}">
                    <input type="text" size="2" class="aiowps-captcha-answer" name="aiowps-captcha-answer" value="" autocomplete="off">
                </strong>
            </div>
        `,
        result,
        verificationString
    };
}

module.exports = {
    generateCaptcha,
    verifyCaptcha,
    generateCaptchaHTML
}; 