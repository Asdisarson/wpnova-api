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
    '÷': (a, b) => a / b,
    // Add text versions of operators
    'plus': (a, b) => a + b,
    'minus': (a, b) => a - b,
    'times': (a, b) => a * b,
    'divided by': (a, b) => a / b
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
 * Creates a captcha equation with support for mixed format (numbers and words)
 * @param {string} format - 'mixed', 'words', or 'numbers'
 * @param {boolean} firstOperandWord - Force first operand to be word (for mixed format)
 */
function generateCaptcha(format = 'numbers', firstOperandWord = false) {
    const num1 = getRandomNumber(1, 10);
    const num2 = getRandomNumber(1, 10);
    const operator = getRandomOperator();
    
    // Calculate the result
    const result = operators[operator](num1, num2);
    
    // Generate a unique string for verification
    const timestamp = Date.now().toString();
    const randomString = crypto.randomBytes(5).toString('hex');
    const verificationString = `${timestamp}${randomString}`;
    
    // Create the equation string based on format
    let equation;
    switch (format) {
        case 'mixed':
            if (firstOperandWord) {
                equation = `${numberToWord[num1]} ${operator} ${num2}`;
            } else {
                equation = `${num1} ${operator} ${numberToWord[num2]}`;
            }
            break;
        case 'words':
            equation = `${numberToWord[num1]} ${operator} ${numberToWord[num2]}`;
            break;
        default: // numbers
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
 * @param {string} format - 'mixed', 'words', or 'numbers'
 * @param {boolean} firstOperandWord - Force first operand to be word (for mixed format)
 */
function generateCaptchaHTML(format = 'numbers', firstOperandWord = false) {
    const { equation, result, verificationString } = generateCaptcha(format, firstOperandWord);
    
    return {
        html: `
            <p class="aiowps-captcha hide-when-displaying-tfa-input"><label for="aiowps-captcha-answer">Please enter an answer in digits:</label></p>
            <div class="aiowps-captcha-equation hide-when-displaying-tfa-input">
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

/**
 * Converts a string number or word to its numeric value
 * @param {string} value - The number or word to convert
 * @returns {number} The numeric value
 */
function parseNumberOrWord(value) {
    // Remove any whitespace and convert to lowercase
    value = value.trim().toLowerCase();
    
    // If it's a numeric string, parse it
    if (/^\d+$/.test(value)) {
        return parseInt(value, 10);
    }
    
    // If it's a word, convert it
    if (wordToNumber.hasOwnProperty(value)) {
        return wordToNumber[value];
    }
    
    throw new Error(`Unable to parse value: ${value}`);
}

/**
 * Solves a captcha equation string
 * @param {string} equation - The equation to solve (e.g., "12 − three")
 * @returns {number} The solution to the equation
 */
function solveCaptcha(equation) {
    // Clean up the equation
    equation = equation.toLowerCase().trim();
    
    // Split the equation into parts
    let parts;
    
    // Handle different operator formats
    if (equation.includes('−')) {
        parts = equation.split('−').map(p => p.trim());
        return parseNumberOrWord(parts[0]) - parseNumberOrWord(parts[1]);
    } else if (equation.includes('-')) {
        parts = equation.split('-').map(p => p.trim());
        return parseNumberOrWord(parts[0]) - parseNumberOrWord(parts[1]);
    } else if (equation.includes('+')) {
        parts = equation.split('+').map(p => p.trim());
        return parseNumberOrWord(parts[0]) + parseNumberOrWord(parts[1]);
    } else if (equation.includes('×')) {
        parts = equation.split('×').map(p => p.trim());
        return parseNumberOrWord(parts[0]) * parseNumberOrWord(parts[1]);
    } else if (equation.includes('*')) {
        parts = equation.split('*').map(p => p.trim());
        return parseNumberOrWord(parts[0]) * parseNumberOrWord(parts[1]);
    }
    
    throw new Error(`Unsupported equation format: ${equation}`);
}

/**
 * Extracts and solves the captcha from a login page HTML
 * @param {string} html - The HTML containing the captcha
 * @returns {Object} The captcha solution and verification info
 */
function extractAndSolveCaptcha(html) {
    // Extract the equation
    const equationMatch = html.match(/class="aiowps-captcha-equation[^>]*><strong>([^=]+)=/);
    if (!equationMatch) {
        throw new Error('Could not find captcha equation');
    }
    
    const equation = equationMatch[1].trim();
    
    // Extract the verification strings
    const stringInfoMatch = html.match(/name="aiowps-captcha-string-info"[^>]*value="([^"]+)"/);
    const tempStringMatch = html.match(/name="aiowps-captcha-temp-string"[^>]*value="([^"]+)"/);
    
    if (!stringInfoMatch || !tempStringMatch) {
        throw new Error('Could not find captcha verification strings');
    }
    
    return {
        answer: solveCaptcha(equation),
        stringInfo: stringInfoMatch[1],
        tempString: tempStringMatch[1],
        equation: equation
    };
}

module.exports = {
    generateCaptcha,
    verifyCaptcha,
    generateCaptchaHTML,
    solveCaptcha,
    extractAndSolveCaptcha,
    wordToNumber,
    numberToWord
}; 